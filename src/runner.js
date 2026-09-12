import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getRun, updateRun, runDir, PORT, skippedSet, AUTODEV_HOME } from './db.js';
import { emit } from './events.js';
import { STAGES, scheduledStages, untilStage, detectTestCmd, findSpecDir, specDirs,
         holdoutPrompt, holdoutFixPrompt, stageN, DESIGN_DIR, designRefs } from './stages.js';
import { repoConfig, modelFor, effortFor } from './config.js';
import { parseClaudeResult } from './metrics.js';
import { causeLine, classify, sessionBlock } from './session.js';
import { promptPrefix, excludeHoldout, sequesterHoldout, restoreHoldout, clearHoldout,
         hasHoldout, TRIAGE, HOLDOUT_VERDICT } from './guidance.js';
import { collectProof, proofFiles, proofDir } from './proof.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = { maxRetries: 2, reviewLoops: 3, stageTimeoutMin: 45, budgetHours: 6 };
// The default 1 MiB is not enough for a 45-minute session under --output-format json: an
// overflow kills the child with SIGTERM and parks the run for a reason unrelated to the work.
const MAX_BUFFER = 64 * 1024 * 1024;

const runId = Number(process.argv[2]);
const resume = process.argv.includes('--resume');
const db = openDb();
const run = getRun(db, runId);
if (!run) { console.error(`no run ${runId}`); process.exit(1); }
const ctx = { runDir: runDir(runId), port: PORT() };
mkdirSync(ctx.runDir, { recursive: true });
const started = Date.now();
const ev = (e) => emit(ctx, { run: runId, ...e });
const saveState = (fields) => { updateRun(db, runId, fields);
  writeFileSync(join(ctx.runDir, 'state.json'), JSON.stringify({ ...getRun(db, runId) })); };

// Hooks settings for headless sessions → live activity events.
const hooksFile = join(ctx.runDir, 'hooks.json');
writeFileSync(hooksFile, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit',
  hooks: [{ type: 'command', command: `node ${join(ROOT, 'bin/hook-emit.js')}` }] }] } }));

const cfg = repoConfig(run.worktree);
// What THIS run actually loaded. The worktree checkout is tracked files only, so an
// uncommitted .autodev.json in the main repo is absent here and its keys read as
// defaults; this line is how an operator notices (doctor warns preflight too).
await ev({ type: 'activity', stage: run.stage, detail: existsSync(join(run.worktree, '.autodev.json'))
  ? `config .autodev.json: ${Object.keys(cfg).length ? Object.entries(cfg).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ').slice(0, 200) : 'present but empty or unparseable'}`
  : 'config: no .autodev.json in the worktree, defaults apply' });
// Design references. A ticket that asks for a screen usually carries a picture of it, and
// until these are on disk the Implement session is working from the words alone. Pulled once
// per run and left in the worktree (untracked), so a resume reuses them rather than
// re-downloading. Best-effort throughout: a run whose ticket has no pictures, or whose Jira
// is unreachable, proceeds exactly as before — the appearance gate in stages.js simply stays
// quiet when the directory is empty.
{
  const key = String(run.jira_key ?? run.issue_ref ?? '');
  const dir = join(run.worktree, DESIGN_DIR);
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(key) && !designRefs(run).length) {
    try {
      const { loadConfig, configComplete, fetchDesignRefs } = await import('./jira-queue.js');
      const jcfg = loadConfig();
      if (configComplete(jcfg)) {
        const got = await fetchDesignRefs(jcfg, key, dir,
          (m) => ev({ type: 'activity', stage: run.stage, detail: m }));
        if (got.length)
          await ev({ type: 'activity', stage: run.stage,
            detail: `design references from ${key}: ${got.join(', ')} → ${DESIGN_DIR}/` });
      }
    } catch (e) {
      await ev({ type: 'activity', stage: run.stage,
        detail: `design references unavailable: ${String(e.message || e).slice(0, 120)}` });
    }
  }
}

// Running cost for THIS run — seeded from prior metrics events so resume keeps counting.
let costUsd = 0;
try {
  for (const l of readFileSync(join(ctx.runDir, 'events.jsonl'), 'utf8').split('\n')) {
    try { const e = JSON.parse(l); if (e.type === 'metrics') costUsd += e.cost_usd ?? 0; } catch {}
  }
} catch {}

// Sessions spent per stage, so a session block is attributable. Counted here rather than
// taken from the outer retry index: stage 6 runs five sessions inside one attempt.
const sessionSeq = new Map();

// Node names these conditions itself and never echoes argv for them, but its wording
// ("spawnSync /path/to/claude ETIMEDOUT") is not what an operator needs to read.
const CODE_MSG = {
  ETIMEDOUT: `the session was killed after the ${CFG.stageTimeoutMin}-minute stage timeout`,
  ENOBUFS: 'the session produced more output than the capture buffer holds',
  ENOENT: 'the claude CLI could not be launched',
};

// Evidence is worth having and never worth failing a run for (FR-007).
function logSession(fields) {
  try { appendFileSync(join(ctx.runDir, 'runner.log'), sessionBlock({ run: runId, ...fields })); }
  catch { /* a read-only run dir or a full disk loses evidence, not the run */ }
}

function runClaude(prompt, stageN) {
  // No cost ceiling here — Rohit's call (specs/003): spend is reported per stage by the
  // metrics events and `autodev cost`, never used to park a run mid-flight.
  const bin = process.env.AUTODEV_CLAUDE_BIN || 'claude';
  const key = STAGES[stageN - 1]?.key;
  const model = modelFor(cfg, key);   // per-stage > repo model > env pin > claude-opus-5
  const effort = effortFor(cfg, key); // per-stage > repo effort > env pin > max
  // Factory rules ride on every session, including the review and holdout ones — they are
  // the repo's constraints on unsupervised work, not the builder's alone.
  prompt = promptPrefix(run.worktree) + prompt;
  const args = process.env.AUTODEV_CLAUDE_BIN
    ? ['-p', prompt] // stub in tests
    : ['-p', prompt, '--dangerously-skip-permissions', '--settings', hooksFile, '--output-format', 'json',
       '--model', model, '--effort', effort];
  // A .js AUTODEV_CLAUDE_BIN (test stubs) runs via node — extensionless scripts can't spawn on Windows.
  const [file, argv] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
  const attempt = (sessionSeq.get(stageN) ?? 0) + 1;
  sessionSeq.set(stageN, attempt);
  // Announce the executing model the moment the session spawns — metrics only arrive after
  // the session ends, which is too late for the dashboard's "what's running now" view.
  ev({ type: 'session', stage: stageN, attempt, model, effort,
       detail: `${model} · ${effort} effort (attempt ${attempt})` });
  const t0 = Date.now();
  let raw;
  try {
    // stdio is deliberately NOT specified: the default both forwards the session's stderr to
    // ours (which spawnRunner has pointed at runner.log, so it stays tailable live) AND
    // attaches it to the thrown error below. Piping would trade the first away for nothing.
    raw = execFileSync(file, argv, {
      cwd: run.worktree, encoding: 'utf8', timeout: CFG.stageTimeoutMin * 60_000,
      maxBuffer: MAX_BUFFER, windowsHide: true,
      env: { ...process.env, AUTODEV_RUN: String(runId), AUTODEV_RUN_DIR: ctx.runDir,
        AUTODEV_PORT: String(ctx.port), AUTODEV_STAGE: String(stageN) },
    });
  } catch (e) {
    // Node's message for a non-zero exit is `Command failed: <full argv>` — and argv[2] is the
    // stage prompt, so letting it escape makes the pipeline's own instruction the run's
    // diagnosis. That string reaches blocked.md, blocked_reason, the parked and retry events,
    // `autodev status` and the dashboard, all at once. Build the reason from what the session
    // actually produced instead.
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    const outcome = e.code ? String(e.code) : `exit ${e.status}`;
    // Only a FAILED session is classified — a model quoting an auth error while reasoning
    // about one must never park a run (FR-012).
    const hit = classify({ code: e.code, out });
    const cause = causeLine(out);
    const named = hit ? `${hit.reason} — ${hit.fix}` : CODE_MSG[e.code];
    const message = named ? (cause ? `${named} (${cause})` : named)
      : cause || `stage ${stageN} session failed (${outcome}) with no output`;
    logSession({ stage: stageN, title: STAGES[stageN - 1]?.title ?? '?', attempt, outcome,
      ms: Date.now() - t0, classified: hit?.code, stdout: e.stdout, stderr: e.stderr });
    // `final` short-circuits the outer retry loop — a terminal condition parks on the first
    // attempt instead of buying the same impossible session three times.
    throw Object.assign(new Error(message),
      { stdout: e.stdout, stderr: e.stderr, ...(hit ? { final: true } : {}) });
  }
  // Per-session telemetry (tokens / model / cost) from the CLI's result JSON — one
  // metrics event per claude call, so review/fix loops surface their true spend.
  const { text, metrics } = parseClaudeResult(raw);
  if (metrics) { costUsd += metrics.cost_usd ?? 0; ev({ type: 'metrics', stage: stageN, ...metrics }); }
  return text;
}

async function park(stage, err, output = '') {
  const reason = String(err.message || err).slice(0, 300);
  writeFileSync(join(ctx.runDir, 'blocked.md'),
    `# Run ${runId} blocked at stage ${stage.n} (${stage.title})\n\n**Reason:** ${reason}\n\n## Last output\n\n\`\`\`\n${output.slice(-4000)}\n\`\`\`\n`);
  saveState({ status: 'BLOCKED', stage: stage.n, blocked_reason: reason });
  await ev({ type: 'parked', stage: stage.n, detail: reason });
  process.exit(0);
}

// A rejection is not a failure: the pipeline read the mission, judged the requirement out of
// scope, and declined it. It gets its own terminal status so `autodev status` never shows a
// working factory as a broken one, and so resume does not re-litigate a settled decision.
async function reject(stage, reason) {
  writeFileSync(join(ctx.runDir, 'blocked.md'),
    `# Run ${runId} rejected at stage ${stage.n} (${stage.title})\n\n**Reason:** ${reason}\n\nThe requirement was judged out of scope against ${join(run.worktree, '.autodev/mission.md')}.\nEdit the mission or narrow the requirement, then start a new run.\n`);
  saveState({ status: 'REJECTED', stage: stage.n, blocked_reason: reason });
  await ev({ type: 'rejected', stage: stage.n, detail: reason });
  process.exit(0);
}

// The spec session's scope verdict, or null when the repo has no mission.md to judge against.
function triageVerdict() {
  const p = join(run.worktree, TRIAGE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Acceptance scenarios written before implementation and hidden from the builder ever since.
// Restored only for the validating session, and removed again before any fix session runs —
// a builder that reads the criteria can satisfy them narrowly instead of fixing the behaviour.
async function holdoutStage(stage) {
  if (!hasHoldout(ctx.runDir)) { run._holdout = 'SKIPPED'; return; }
  for (let round = 1; round <= CFG.reviewLoops; round++) {
    rmSync(join(run.worktree, HOLDOUT_VERDICT), { force: true });
    restoreHoldout(run.worktree, ctx.runDir);
    await ev({ type: 'activity', stage: stage.n, detail: `holdout scenarios — round ${round}/${CFG.reviewLoops}` });
    try { runClaude(holdoutPrompt(), stage.n); } finally { clearHoldout(run.worktree); }
    const p = join(run.worktree, HOLDOUT_VERDICT);
    if (!existsSync(p)) { // no verdict written — advisory, not a reason to fail a green run
      await ev({ type: 'activity', stage: stage.n, detail: 'holdout session wrote no verdict — skipped' });
      run._holdout = 'SKIPPED'; return;
    }
    const { verdict, findings = [] } = JSON.parse(readFileSync(p, 'utf8'));
    if (verdict === 'PASS') {
      run._holdout = 'PASS';
      await ev({ type: 'activity', stage: stage.n, detail: 'holdout scenarios PASS' });
      return;
    }
    run._holdout = 'FAIL';
    // Budget spent. Throwing here rather than leaving a flag for stage.check is what makes
    // this gate real: the runner calls testStage INSTEAD of the stage's check, so a verdict
    // that only sets a field is a verdict nothing ever reads.
    if (round === CFG.reviewLoops)
      throw Object.assign(new Error(`holdout scenarios still failing after ${round} round(s): ${findings.map(f => f.observed ?? f.scenario).join('; ').slice(0, 200)}`), { final: true });
    await ev({ type: 'retry', stage: stage.n, detail: `holdout: ${findings.length} finding(s) — fixing` });
    runClaude(holdoutFixPrompt(findings), stage.n);
  }
}

// ---- pushMode "direct": the runner lands the branch on the base branch itself ----
// No pull request, no `gh`, no session. Stage 5 rebases the branch onto the base tip and
// pushes it (so the remote has what tests will run against); stage 8, after tests, rebases
// once more and fast-forwards the base branch to it. Run #9 parked on "This branch can't be
// rebased" from GitHub's merge API after main moved under an open PR; a local rebase either
// succeeds or names the conflicting commit, and the operator resolves it on the branch.
const direct = cfg.pushMode === 'direct';
const gitq = (args, extra = {}) => execFileSync('git', args, { cwd: run.worktree, encoding: 'utf8',
  stdio: 'pipe', timeout: 120_000, windowsHide: true, ...extra }).trim();
function baseBranch() {
  if (cfg.baseBranch) return String(cfg.baseBranch);
  try { return gitq(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch {}
  return 'main';
}
// Rebase the branch onto the base tip. A conflict aborts the rebase (the worktree is left
// exactly as it was) and parks the run naming the commit that did not apply — final, because
// no retry rewrites history for us.
function rebaseOnto(base) {
  gitq(['fetch', '-q', 'origin', base]);
  try { gitq(['rebase', '-q', `origin/${base}`]); }
  catch (e) {
    try { gitq(['rebase', '--abort']); } catch { /* nothing in progress */ }
    throw Object.assign(new Error(`rebase onto origin/${base} conflicts: ${causeLine(`${e.stdout ?? ''}\n${e.stderr ?? ''}`, 200)} — resolve on ${run.branch} by hand, then resume`), { final: true });
  }
}
async function pushDirect(stage) {
  const base = baseBranch();
  await ev({ type: 'activity', stage: stage.n, detail: `push: rebase onto origin/${base}, push ${run.branch} — no pull request (pushMode direct)` });
  rebaseOnto(base);
  gitq(['push', '-q', '-u', '--force-with-lease', 'origin', run.branch]);
  await ev({ type: 'pushed', stage: stage.n, detail: `${gitq(['rev-parse', '--short=12', 'HEAD'])} on ${run.branch}, rebased onto origin/${base}` });
}
// Did an EARLIER attempt of this run already land? Only a resume has a 'merged' event on
// file — the current attempt writes its own after the check below.
const priorMerge = () => {
  try {
    return readFileSync(join(ctx.runDir, 'events.jsonl'), 'utf8').split('\n')
      .some(l => { try { return JSON.parse(l).type === 'merged'; } catch { return false; } });
  } catch { return false; }
};

// Stage 8's "merge" in direct mode: fast-forward the base branch to this branch. Idempotent
// on resume — a run parked after landing (deploy or proof failed) finds its HEAD already on
// the base and records that instead of pushing again.
async function landDirect(stage) {
  const base = baseBranch();
  gitq(['fetch', '-q', 'origin', base]);
  const head = gitq(['rev-parse', 'HEAD']);
  let landed = false;
  try { gitq(['merge-base', '--is-ancestor', head, `origin/${base}`]); landed = true; } catch { /* not yet */ }
  if (landed) {
    // HEAD sitting on the base means one of two opposite things. A run that landed on an
    // earlier attempt and parked in deploy or proof finds ITS OWN commits there: idempotent
    // resume, recorded and allowed. A run whose implement stage wrote nothing finds the base
    // itself — it produced no commit, so there is nothing to land, and every later stage
    // would test, deploy and report on code this run never wrote. That is how run #19 closed
    // SCRUM-85 with an empty branch and a deploy of the commit already on main. A prior
    // 'merged' event is what separates the two.
    if (!priorMerge()) throw Object.assign(new Error(
      `nothing to land: ${run.branch} has no commits over origin/${base} — the implement stage produced no code`),
      { final: true });
    await ev({ type: 'merged', stage: stage.n, detail: `${head.slice(0, 12)} (already on ${base} before this attempt)` });
    return;
  }
  await ev({ type: 'activity', stage: stage.n, detail: `landing ${run.branch} on ${base} (fast-forward push, pushMode direct)` });
  rebaseOnto(base);
  try { gitq(['push', '-q', 'origin', `HEAD:${base}`]); }
  catch (e) {
    throw Object.assign(new Error(`push to ${base} failed: ${causeLine(`${e.stdout ?? ''}\n${e.stderr ?? ''}`, 200) || e.message}`), { final: true });
  }
  await ev({ type: 'merged', stage: stage.n, detail: `${gitq(['rev-parse', '--short=12', 'HEAD'])} via git push origin HEAD:${base} (fast-forward, pushMode direct)` });
  try { gitq(['push', '-q', 'origin', '--delete', run.branch], { timeout: 60_000 }); }
  catch { await ev({ type: 'activity', stage: stage.n, detail: `remote branch ${run.branch} not deleted — remove it by hand` }); }
}

// One deploy per repository at a time. Runs implement and test in parallel worktrees, but
// two deploy commands racing the same service (and two proof commands photographing a
// half-rolled one) is how a parallel queue ships the wrong commit. The lock is a directory
// under AUTODEV_HOME keyed by repo path — mkdir is atomic on every platform — holding the
// owner's pid so a lock left by a killed runner is reclaimed, not waited on forever.
const lockDir = () => join(AUTODEV_HOME(), 'locks', `deploy-${createHash('sha1').update(run.repo_path).digest('hex').slice(0, 12)}`);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function withDeployLock(stage, fn) {
  const dir = lockDir();
  mkdirSync(dirname(dir), { recursive: true });
  const deadline = Date.now() + CFG.stageTimeoutMin * 60_000;
  let announced = false;
  for (;;) {
    try { mkdirSync(dir); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null;
      try { owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')); } catch { /* being written, or stale */ }
      if (owner && owner.run !== runId && !pidAlive(owner.pid)) {
        await ev({ type: 'activity', stage: stage.n, detail: `deploy lock left by dead run #${owner.run} (pid ${owner.pid}) — reclaimed` });
        rmSync(dir, { recursive: true, force: true }); continue;
      }
      if (owner?.run === runId) { rmSync(dir, { recursive: true, force: true }); continue; } // our own, from a resume
      if (Date.now() > deadline)
        throw Object.assign(new Error(`deploy lock held by run #${owner?.run ?? '?'} for over ${CFG.stageTimeoutMin} minutes`), { final: true });
      if (!announced) { announced = true;
        await ev({ type: 'activity', stage: stage.n, detail: `waiting for deploy lock held by run #${owner?.run ?? '?'}` }); }
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ run: runId, pid: process.pid, since: Date.now() }));
  try { return await fn(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// What GitHub says about the run's PR — null when gh is missing or the query fails, so a
// diagnostic read can never be the reason a deploy stage parks.
function prState(pr) {
  try {
    return JSON.parse(execFileSync('gh', ['pr', 'view', pr, '--json', 'state,mergeCommit'],
      { cwd: run.worktree, encoding: 'utf8', timeout: 30_000, windowsHide: true }));
  } catch { return null; }
}

// Merge and deploy, executed by the runner rather than a session. Config lives in the target
// repo's .autodev.json:
//   {"deploy": {"merge": true, "strategy": "squash", "cmd": "./deploy.sh", "proofCmd": "./proof.sh"}}
// Every step it takes is recorded as an event (merged, deployed, proof) — the ticket close is
// built from those events, never from a sentence this code could write regardless of outcome.
async function deployStage(stage) {
  const d = cfg.deploy || {};
  if (d.merge !== false) {
    const pr = getRun(db, runId).pr_url;
    if (!pr && direct) await landDirect(stage);
    else if (!pr) throw Object.assign(new Error('deploy needs a merged PR but no PR was opened (push stage skipped?)'), { final: true });
    const strategy = ['squash', 'merge', 'rebase'].includes(d.strategy) ? d.strategy : 'squash';
    // Idempotent on resume: a run parked after the merge (deploy or proof failed) must not
    // fail again on "pull request already merged" when the operator resumes it.
    const before = pr ? prState(pr) : null;
    if (!pr) { /* landed above */ } else if (before?.state === 'MERGED') {
      await ev({ type: 'merged', stage: stage.n, detail: `${before.mergeCommit?.oid?.slice(0, 12) ?? 'commit unknown'} (already merged before this attempt)` });
    } else {
      await ev({ type: 'activity', stage: stage.n, detail: `merging ${pr} (--${strategy})` });
      // No --delete-branch: gh would try to check out the default branch here, in a worktree
      // whose branch IS the PR branch while the default branch is checked out in the main
      // repo — and report that as a failure after the merge already happened. The remote
      // branch is removed separately below, best-effort; the local one goes with the worktree.
      try {
        execFileSync('gh', ['pr', 'merge', pr, `--${strategy}`],
          { cwd: run.worktree, encoding: 'utf8', timeout: 120_000, windowsHide: true });
      } catch (e) {
        throw Object.assign(new Error(`gh pr merge failed: ${causeLine(`${e.stdout ?? ''}\n${e.stderr ?? ''}`, 200) || e.message}`), { final: true });
      }
      const after = prState(pr);
      await ev({ type: 'merged', stage: stage.n, detail: `${after?.mergeCommit?.oid?.slice(0, 12) ?? 'commit unknown'} via gh pr merge --${strategy}` });
      try { execFileSync('git', ['push', 'origin', '--delete', run.branch], { cwd: run.worktree, stdio: 'pipe', timeout: 60_000, windowsHide: true }); }
      catch { await ev({ type: 'activity', stage: stage.n, detail: `remote branch ${run.branch} not deleted — remove it by hand` }); }
    }
  }
  if (d.cmd) {
    await ev({ type: 'activity', stage: stage.n, detail: `deploy: ${d.cmd}` });
    // Shell string by design, exactly like testCmd: it is written by the repo's owner in a
    // committed .autodev.json and needs pipes and && to be useful. Nothing model-generated
    // or run-derived is interpolated into it.
    const t0 = Date.now();
    try {
      const out = execSync(d.cmd, { cwd: run.repo_path, encoding: 'utf8', timeout: CFG.stageTimeoutMin * 60_000, windowsHide: true });
      writeFileSync(join(ctx.runDir, 'deploy-output.txt'), out);
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      writeFileSync(join(ctx.runDir, 'deploy-output.txt'), out);
      // No fix loop here on purpose: a half-deployed application is the one state in this
      // pipeline where another unsupervised session can make things materially worse.
      throw Object.assign(new Error(`deploy command failed: ${causeLine(out, 200)}`), { final: true });
    }
    await ev({ type: 'deployed', stage: stage.n, detail: `${d.cmd} · exit 0 · ${Math.round((Date.now() - t0) / 1000)}s` });
  }
  if (d.proofCmd) {
    // The repo shows its own work: a screenshot, a health check, a version endpoint — whatever
    // proves the deploy to the person reading the ticket. Same trust class as cmd. It has to
    // leave a file behind; a proof command that produces nothing is a failed gate, not a pass.
    // ponytail: a resume after a proof failure re-runs the deploy command as well — a redeploy
    // of the same commit, harmless but slow; telling the two failures apart is not worth a flag.
    const dir = proofDir(ctx.runDir);
    mkdirSync(dir, { recursive: true });
    const had = new Set(proofFiles(ctx.runDir).map(f => f.name));
    await ev({ type: 'activity', stage: stage.n, detail: `proof: ${d.proofCmd}` });
    try {
      const out = execSync(d.proofCmd, { cwd: run.repo_path, encoding: 'utf8', timeout: CFG.stageTimeoutMin * 60_000, windowsHide: true,
        env: { ...process.env, AUTODEV_PROOF_DIR: dir, AUTODEV_RUN: String(runId) } });
      writeFileSync(join(ctx.runDir, 'proof-output.txt'), out);
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      writeFileSync(join(ctx.runDir, 'proof-output.txt'), out);
      throw Object.assign(new Error(`proof command failed: ${causeLine(out, 200) || d.proofCmd}`), { final: true });
    }
    if (!proofFiles(ctx.runDir).some(f => !had.has(f.name)))
      throw Object.assign(new Error(`proof command left no evidence in ${dir}: ${d.proofCmd}`), { final: true });
  }
  run._deployed = true;
}

async function reviewStage(stage) { // inner review⇄fix loop
  for (let round = 1; round <= CFG.reviewLoops; round++) {
    rmSync(join(run.worktree, '.autodev/review.json'), { force: true });
    await ev({ type: 'activity', stage: stage.n, detail: `review round ${round}/${CFG.reviewLoops}` });
    runClaude(stage.prompt(run), stage.n);
    try { stage.check(run); return; }
    catch (e) {
      const p = join(run.worktree, '.autodev/review.json');
      if (!existsSync(p)) throw e; // review session broke — outer retry handles it
      if (round === CFG.reviewLoops) { e.final = true; throw e; } // internal budget spent — park directly
      const { findings } = JSON.parse(readFileSync(p, 'utf8'));
      await ev({ type: 'retry', stage: stage.n, detail: `${findings?.length ?? '?'} findings — fixing` });
      runClaude(stage.fixPrompt(run, findings), stage.n);
    }
  }
}

async function testStage(stage) {
  // precedence: --test-cmd (run row) > repo .autodev.json > detection — never a silent pass.
  const cmd = run.test_cmd || repoConfig(run.worktree).testCmd || detectTestCmd(run.worktree);
  if (!cmd) {
    run._testsPassed = false;
    throw Object.assign(new Error(
      'no test command detected — pass --test-cmd "<cmd>" or set "testCmd" in .autodev.json; "tested PR out" must never be vacuous'), { final: true });
  }
  await ev({ type: 'activity', stage: stage.n, detail: `test command: ${cmd}` });
  mkdirSync(join(run.worktree, '.autodev'), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const out = execSync(cmd, { cwd: run.worktree, encoding: 'utf8', timeout: CFG.stageTimeoutMin * 60_000, windowsHide: true });
      writeFileSync(join(run.worktree, '.autodev/test-output.txt'), out); run._testsPassed = true;
      break;
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      writeFileSync(join(run.worktree, '.autodev/test-output.txt'), out);
      if (attempt >= CFG.maxRetries) { run._testsPassed = false;
        throw Object.assign(new Error(`tests still failing after ${attempt} fix attempts`), { final: true }); }
      await ev({ type: 'retry', stage: stage.n, detail: `tests failed — fix attempt ${attempt + 1}` });
      runClaude(stage.prompt(run), stage.n);
    }
  }
  // The repo's own suite is the builder's; the holdout scenarios are not. Only both green
  // makes this stage green. Outside the loop above on purpose: a holdout failure is not a
  // test-command failure, and running it inside would let the test⇄fix loop swallow the
  // verdict and park the run under the wrong diagnosis.
  await holdoutStage(stage);
}

// ---- main loop ----
// Read the park reason BEFORE clearing it. Without this a resume re-issues the byte-identical
// prompt that just failed three times and throws the diagnosis away — resume would be a retry.
const resumeSeed = resume ? run.blocked_reason : null;
if (resume) { saveState({ status: 'RUNNING', blocked_reason: null }); await ev({ type: 'resumed', stage: run.stage }); }
saveState({ pid: process.pid });

// Stages bypassed for this run: dashboard/--skip picks on the run row, plus the repo's
// standing .autodev.json "skip" list (stage names or numbers) — a repo that finds a stage
// too slow can retire it for every run without remembering a flag.
const skipped = skippedSet(run);
for (const s of cfg.skip ?? []) { const n = stageN(s); if (n) skipped.add(n); }
// Snapshot taken before any stage runs, so the spec stage's creation can be identified by diff.
const specsBefore = new Set(specDirs(run.worktree));
// Before the spec session can commit them: holdout scenarios must never enter git, or the
// builder reads out of the history what the sequester takes off the disk.
excludeHoldout(run.worktree);
const PIPELINE = scheduledStages(cfg);
// Ask the CLI whether it is signed in BEFORE spending a stage on finding out. Run #9 bought
// three identical sessions and parked with a JSON blob for a reason `claude auth status`
// reports in 200 ms. Fail open: a CLI without the subcommand, or one that answers with
// something unparseable, changes nothing — the session-level classification still applies.
{
  const bin = process.env.AUTODEV_CLAUDE_BIN || 'claude';
  const [file, argv] = bin.endsWith('.js') ? [process.execPath, [bin, 'auth', 'status']] : [bin, ['auth', 'status']];
  let status = null;
  try { status = JSON.parse(execFileSync(file, argv, { encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: 'pipe' })); }
  catch (e) { try { status = JSON.parse(String(e.stdout ?? '')); } catch { status = null; } }
  if (status && status.loggedIn === false) {
    const first = PIPELINE.find(s => s.n >= run.stage) ?? PIPELINE[0];
    await park(first, new Error('the claude CLI is not signed in (claude auth status: loggedIn false) — run `claude` once interactively, `/login`, then `autodev resume ' + runId + '`'));
  }
  if (status) await ev({ type: 'activity', stage: run.stage, detail: `claude auth: ${status.email ?? 'signed in'}${status.subscriptionType ? ` (${status.subscriptionType})` : ''}` });
}
// Hard stop after stage N: change-controlled repos can forbid autonomous push/PR
// outright; precedence lives in untilStage, shared with run kickoff so the two never disagree.
const until = untilStage(cfg, run.until_stage);
for (const stage of PIPELINE.filter(s => s.n >= run.stage && s.n <= until && !skipped.has(s.n))) {
  if (Date.now() - started > CFG.budgetHours * 3_600_000) await park(stage, new Error('wall-clock budget exceeded'));
  saveState({ stage: stage.n });
  await ev({ type: 'stage_started', stage: stage.n, detail: stage.title });
  // What proof/ held before this stage — the diff afterwards is what the stage contributed,
  // including files a deploy proof command wrote there itself.
  const proofBefore = new Set(proofFiles(ctx.runDir).map(f => f.name));
  // Only the stage being resumed is seeded, and only its first attempt: `lastErr` is
  // re-declared per stage, so nothing carries into the stages after it (FR-017).
  let lastErr = resumeSeed && stage.n === run.stage ? { message: resumeSeed } : null;
  let lastOut = '';
  let ok = false;
  for (let attempt = 0; attempt <= CFG.maxRetries && !ok; attempt++) {
    try {
      if (stage.key === 'review') await reviewStage(stage);
      else if (stage.key === 'test') await testStage(stage);
      else if (stage.key === 'push' && direct) { await pushDirect(stage); stage.check(run); }
      else if (stage.key === 'deploy') { await withDeployLock(stage, () => deployStage(stage)); stage.check(run); }
      else {
        const extra = lastErr ? `\n\nA previous attempt failed its verification: ${lastErr.message}. Address that specifically.` : '';
        lastOut = runClaude(stage.prompt(run) + extra, stage.n);
        // Scope first: a rejected requirement has no spec to gate, so checking artifacts
        // before the verdict would park the run for the absence the rejection caused.
        if (stage.key === 'spec') {
          const t = triageVerdict();
          if (t?.verdict === 'REJECT') await reject(stage, String(t.reason || 'out of scope').slice(0, 300));
        }
        stage.check(run);
      }
      ok = true;
    } catch (e) {
      // Both channels: blocked.md's "Last output" block used to carry stdout alone, so a
      // session that explained itself on stderr left the park with nothing to show.
      lastErr = e;
      lastOut = (e.stdout ?? e.stderr) !== undefined
        ? `${e.stdout ?? ''}${e.stderr ? `\n${e.stderr}` : ''}` : lastOut;
      if (e.final) break; // stage's internal budget exhausted — no outer re-runs
      if (attempt < CFG.maxRetries) await ev({ type: 'retry', stage: stage.n, detail: String(e.message).slice(0, 200) });
    }
  }
  if (!ok) await park(stage, lastErr, lastOut);
  // Keep the gate's artifact with the run. The worktree is disposable; the evidence that the
  // ticket is closed on is not, and only copies of files the runner itself checked go in.
  collectProof({ runDir: ctx.runDir, worktree: run.worktree, stageKey: stage.key });
  const proofAdded = proofFiles(ctx.runDir).map(f => f.name).filter(n => !proofBefore.has(n));
  if (proofAdded.length) await ev({ type: 'proof', stage: stage.n, detail: proofAdded.join(', ') });
  // Pin the spec the moment stage 1 has produced one, so stages 2-4 target the directory THIS
  // run owns rather than re-picking the highest-numbered one — which, in a repo whose specs/
  // grows underneath a long run, may belong to somebody else's run entirely (FR-020).
  // Recorded from what the runner observes on disk, never from what the session claims.
  // "Highest-numbered" is the wrong question here: a repo can already hold specs above the one
  // stage 1 writes. Diff the directory listing instead, and fall back to highest only when the
  // diff is not a single unambiguous addition.
  if (stage.key === 'spec' && !run.spec_dir) {
    const added = specDirs(run.worktree).filter(d => !specsBefore.has(d));
    const d = added.length === 1 ? join(run.worktree, 'specs', added[0]) : findSpecDir(run.worktree);
    if (d) {
      run.spec_dir = relative(run.worktree, d).replaceAll('\\', '/'); // repo-relative, POSIX
      saveState({ spec_dir: run.spec_dir });
    }
  }
  // The moment the spec is accepted, the acceptance criteria leave the repository. Every
  // session after this one — builder, verifier, reviewer, fixer — runs blind to them.
  if (stage.key === 'spec' && sequesterHoldout(run.worktree, ctx.runDir))
    await ev({ type: 'activity', stage: stage.n, detail: 'holdout scenarios sequestered — builder cannot read them' });
  if (stage.key === 'push' && existsSync(join(run.worktree, '.autodev/pr-url'))) {
    const url = readFileSync(join(run.worktree, '.autodev/pr-url'), 'utf8').trim();
    saveState({ pr_url: url }); await ev({ type: 'pr_opened', stage: stage.n, detail: url });
  }
  // Review + Test are green — the stage-5 draft PR may now face reviewers. Done here rather
  // than after the loop because the deploy stage merges it, and `gh pr merge` on a draft
  // fails: marking ready has to happen while there is still a draft to mark.
  if (stage.key === 'test') {
    const pr = getRun(db, runId).pr_url;
    if (pr) {
      try {
        execFileSync('gh', ['pr', 'ready', pr], { cwd: run.worktree, encoding: 'utf8', timeout: 30_000, windowsHide: true });
        await ev({ type: 'activity', stage: stage.n, detail: 'draft PR marked ready for review' });
      } catch {
        await ev({ type: 'activity', stage: stage.n, detail: 'could not mark PR ready (gh missing or not a draft) — check it manually' });
      }
    }
  }
  await ev({ type: 'stage_done', stage: stage.n, detail: stage.title });
}
saveState({ status: 'DONE' });
await ev({ type: 'run_done', stage: until,
  ...(until < PIPELINE.at(-1).n ? { detail: `stopped after stage ${until} (${STAGES[until - 1].title}) as requested` } : {}) });
db.close();
