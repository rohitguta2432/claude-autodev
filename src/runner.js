import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getRun, updateRun, runDir, PORT, skippedSet } from './db.js';
import { emit } from './events.js';
import { STAGES, stageN, detectTestCmd, findSpecDir, specDirs } from './stages.js';
import { repoConfig, modelFor } from './config.js';
import { parseClaudeResult } from './metrics.js';
import { causeLine, classify, sessionBlock } from './session.js';

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
  if (cfg.maxCostUsd && costUsd >= cfg.maxCostUsd)
    throw Object.assign(new Error(
      `cost budget exceeded: $${costUsd.toFixed(2)} spent >= maxCostUsd $${cfg.maxCostUsd} (.autodev.json) — raise it and resume`), { final: true });
  const bin = process.env.AUTODEV_CLAUDE_BIN || 'claude';
  const model = modelFor(cfg, STAGES[stageN - 1]?.key); // per-stage > repo model > env pin
  const args = process.env.AUTODEV_CLAUDE_BIN
    ? ['-p', prompt] // stub in tests
    : ['-p', prompt, '--dangerously-skip-permissions', '--settings', hooksFile, '--output-format', 'json',
       ...(model ? ['--model', model] : [])];
  // A .js AUTODEV_CLAUDE_BIN (test stubs) runs via node — extensionless scripts can't spawn on Windows.
  const [file, argv] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
  const attempt = (sessionSeq.get(stageN) ?? 0) + 1;
  sessionSeq.set(stageN, attempt);
  const t0 = Date.now();
  let raw;
  try {
    // stdio is deliberately NOT specified: the default both forwards the session's stderr to
    // ours (which spawnRunner has pointed at runner.log, so it stays tailable live) AND
    // attaches it to the thrown error below. Piping would trade the first away for nothing.
    raw = execFileSync(file, argv, {
      cwd: run.worktree, encoding: 'utf8', timeout: CFG.stageTimeoutMin * 60_000,
      maxBuffer: MAX_BUFFER,
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
      const out = execSync(cmd, { cwd: run.worktree, encoding: 'utf8', timeout: CFG.stageTimeoutMin * 60_000 });
      writeFileSync(join(run.worktree, '.autodev/test-output.txt'), out); run._testsPassed = true; return;
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      writeFileSync(join(run.worktree, '.autodev/test-output.txt'), out);
      if (attempt >= CFG.maxRetries) { run._testsPassed = false;
        throw Object.assign(new Error(`tests still failing after ${attempt} fix attempts`), { final: true }); }
      await ev({ type: 'retry', stage: stage.n, detail: `tests failed — fix attempt ${attempt + 1}` });
      runClaude(stage.prompt(run), stage.n);
    }
  }
}

// ---- main loop ----
// Read the park reason BEFORE clearing it. Without this a resume re-issues the byte-identical
// prompt that just failed three times and throws the diagnosis away — resume would be a retry.
const resumeSeed = resume ? run.blocked_reason : null;
if (resume) { saveState({ status: 'RUNNING', blocked_reason: null }); await ev({ type: 'resumed', stage: run.stage }); }
saveState({ pid: process.pid });

const skipped = skippedSet(run); // stages the user skipped from the dashboard — bypassed here too
// Snapshot taken before any stage runs, so the spec stage's creation can be identified by diff.
const specsBefore = new Set(specDirs(run.worktree));
// Hard stop after stage N — change-controlled repos can forbid autonomous push/PR
// outright. Precedence: --until (run row) > .autodev.json "until" > "push": false.
const until = run.until_stage || stageN(cfg.until) || (cfg.push === false ? stageN('verify') : null) || STAGES.length;
for (const stage of STAGES.filter(s => s.n >= run.stage && s.n <= until && !skipped.has(s.n))) {
  if (Date.now() - started > CFG.budgetHours * 3_600_000) await park(stage, new Error('wall-clock budget exceeded'));
  saveState({ stage: stage.n });
  await ev({ type: 'stage_started', stage: stage.n, detail: stage.title });
  // Only the stage being resumed is seeded, and only its first attempt: `lastErr` is
  // re-declared per stage, so nothing carries into the stages after it (FR-017).
  let lastErr = resumeSeed && stage.n === run.stage ? { message: resumeSeed } : null;
  let lastOut = '';
  let ok = false;
  for (let attempt = 0; attempt <= CFG.maxRetries && !ok; attempt++) {
    try {
      if (stage.key === 'review') await reviewStage(stage);
      else if (stage.key === 'test') await testStage(stage);
      else {
        const extra = lastErr ? `\n\nA previous attempt failed its verification: ${lastErr.message}. Address that specifically.` : '';
        lastOut = runClaude(stage.prompt(run) + extra, stage.n);
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
  if (stage.key === 'push' && existsSync(join(run.worktree, '.autodev/pr-url'))) {
    const url = readFileSync(join(run.worktree, '.autodev/pr-url'), 'utf8').trim();
    saveState({ pr_url: url }); await ev({ type: 'pr_opened', stage: stage.n, detail: url });
  }
  await ev({ type: 'stage_done', stage: stage.n, detail: stage.title });
}
// Review + Test are green — the stage-5 draft PR may now face reviewers.
const finalRun = getRun(db, runId);
if (finalRun.pr_url) {
  try {
    execFileSync('gh', ['pr', 'ready', finalRun.pr_url], { cwd: run.worktree, encoding: 'utf8', timeout: 30_000 });
    await ev({ type: 'activity', stage: STAGES.at(-1).n, detail: 'draft PR marked ready for review' });
  } catch {
    await ev({ type: 'activity', stage: STAGES.at(-1).n, detail: 'could not mark PR ready (gh missing or not a draft) — check it manually' });
  }
}
saveState({ status: 'DONE' });
await ev({ type: 'run_done', stage: until,
  ...(until < STAGES.length ? { detail: `stopped after stage ${until} (${STAGES[until - 1].title}) as requested` } : {}) });
db.close();
