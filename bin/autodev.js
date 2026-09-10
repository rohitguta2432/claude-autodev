#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { PORT, runDir, openDb, createRun, getRun, listRuns, updateRun, deleteRun, AUTODEV_HOME } from '../src/db.js';
import { emit } from '../src/events.js';
import { specDirFor, isCompleteSpecDir, STAGES, scheduledStages, stageN, untilStage } from '../src/stages.js';
import { parseJiraRef, fetchIssue, leadingJiraKey } from '../src/jira.js';
import { doctor, printChecks } from '../src/doctor.js';
import { repoConfig } from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = () => `http://127.0.0.1:${PORT()}`;
const [cmd, ...rest] = process.argv.slice(2);

// The sqlite db + per-run jsonl are the source of truth (see src/events.js's own comment:
// "server optional by design"). The HTTP server only serves the live dashboard, so CLI
// commands read/write the db directly and treat the server as best-effort — never block
// run correctness on a live round trip to it.
async function ensureServer() {
  try { await fetch(`${base()}/api/runs`, { signal: AbortSignal.timeout(1000) }); return; }
  catch {
    const log = openSync(join(process.env.AUTODEV_HOME || join(homedir(), '.autodev'), 'server.log'), 'a');
    // process.execPath, never a bare 'node': autodev needs >=22.5 for node:sqlite, and the
    // interpreter already running us is the only one known to satisfy that. A PATH 'node' that
    // is missing or too old dies into the log and leaves the run RUNNING forever.
    // windowsHide on every launch (see the structural test in cli.test.js): on a detached
    // child it is a no-op (DETACHED_PROCESS owns no console), but console children launched
    // FROM these console-less processes each get a fresh visible console window without it.
    spawn(process.execPath, [join(ROOT, 'src/server.js')], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  }
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// One-time informed consent for --dangerously-skip-permissions — a stranger on a
// new machine must make this decision explicitly, not inherit it silently.
// Stubbed sessions (AUTODEV_CLAUDE_BIN) never reach real claude, so tests are exempt.
async function ensureConsent() {
  if (process.env.AUTODEV_CLAUDE_BIN) return;
  const consentPath = join(AUTODEV_HOME(), 'consent');
  if (existsSync(consentPath)) return;
  const msg = `autodev runs every stage as a headless claude session with
--dangerously-skip-permissions: the agent edits files, runs commands, commits,
pushes, and opens PRs WITHOUT asking per action. Isolation is a git worktree —
weaker than a sandbox: it shares .git with your main checkout and the sessions
inherit your full environment (credentials included). Only point autodev at
repos and requirements you'd trust an unsupervised agent with.`;
  if (!process.stdin.isTTY) {
    console.error(`${msg}\n\nno TTY to confirm on — run autodev once interactively to record consent (${consentPath})`);
    process.exit(1);
  }
  console.log(msg);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('\nProceed and remember this choice? [y/N] ')).trim();
  rl.close();
  if (!/^y(es)?$/i.test(a)) { console.error('aborted — consent not given'); process.exit(1); }
  mkdirSync(AUTODEV_HOME(), { recursive: true });
  writeFileSync(consentPath, `--dangerously-skip-permissions consented at ${new Date().toISOString()}\n`);
}

function spawnRunner(id, extra = []) {
  const log = openSync(join(runDir(id), 'runner.log'), 'a');
  spawn(process.execPath, [join(ROOT, 'src/runner.js'), String(id), ...extra],
    { detached: true, stdio: ['ignore', log, log], env: process.env, windowsHide: true }).unref();
}

// ponytail: the brief's one-liner (`rest.filter(...)`) mis-parses `--repo <path>` —
// a plain loop that recognizes known flags and their values is clearer and correct.
function parseRunArgs(args) {
  const words = [];
  let repoPath = process.cwd();
  let noSpawn = false;
  let specArg = null;
  let branchArg = null;
  let testCmd = null;
  let until = null;
  let issueRef = null;
  let plainIssueRef = null; // recorded on the run verbatim, no gh/MCP fetch (jira-queue kickoffs)
  let skip = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') { repoPath = args[++i]; }
    else if (a === '--issue') { issueRef = String(args[++i]).replace(/^#/, ''); }
    else if (a === '--issue-ref') { plainIssueRef = String(args[++i]); }
    else if (a === '--spec') { specArg = args[++i]; }
    else if (a === '--branch') { branchArg = args[++i]; }
    else if (a === '--test-cmd') { testCmd = args[++i]; }
    else if (a === '--skip') { // "3,5" or a stage name list — start with these already skipped
      skip = String(args[++i]).split(',').map(s => stageN(s.trim())).filter(Boolean);
      if (!skip.length) { console.error(`--skip wants stage numbers or names: ${STAGES.map(s => s.key).join('|')}`); process.exit(1); }
    }
    else if (a === '--until') {
      until = stageN(args[++i]);
      if (!until) { console.error(`--until wants a stage 1-${STAGES.length} or a name: ${STAGES.map(s => s.key).join('|')}`); process.exit(1); }
    }
    else if (a === '--no-push') { until = stageN('verify'); } // stop before anything leaves the machine
    else if (a === '--no-spawn') { noSpawn = true; }
    else words.push(a);
  }
  return { requirement: words.join(' '), repoPath: resolve(repoPath), noSpawn, specArg, branchArg, testCmd, until, issueRef, plainIssueRef, skip };
}

const USAGE = 'usage: autodev run "<requirement>"|<JIRA-KEY> [--repo <path>] [--issue <n>] [--spec <path>] [--branch <name>] [--test-cmd <cmd>] [--skip <stages>] [--until <stage>] [--no-push]'
  + ' | init [--repo <path>] | daemon [--repo <path>] [--interval <min>] [--max-parallel <n>] [--auto-accept] [--once]'
  + ' | status | resume <id> | stop <id> | cost <id> | doctor [path] | selftest | install-skill [--project] [--force] | uninstall-skill [--project]';

if (cmd === 'run') {
  let { requirement, repoPath, noSpawn, specArg, branchArg, testCmd, until, issueRef, plainIssueRef, skip } = parseRunArgs(rest);
  let slugPrefix = null;
  if (issueRef) {
    const { fetchGhIssue } = await import('../src/daemon.js');
    try {
      const issue = fetchGhIssue(repoPath, issueRef);
      requirement = issue.requirement;
      slugPrefix = `${issueRef} ${issue.title}`;
      console.log(`#${issueRef} ${issue.title}`);
    } catch (e) {
      console.error(`could not read issue #${issueRef} via gh: ${String(e.stderr || e.message).trim().split('\n').at(-1)}`);
      process.exit(1);
    }
  }
  if (!requirement) { console.error(USAGE); process.exit(1); }

  await ensureConsent();
  // Preflight — a stranger's first failure should cost five seconds, not a parked run.
  const failures = printChecks((await doctor(repoPath)).filter(c => c.severity !== 'pass'));
  if (failures.length) { console.error(`\n${failures.length} preflight check(s) failed — fix and re-run (autodev doctor to re-check)`); process.exit(1); }

  // Autonomy with visibility: the default pipeline leaves the machine (push + draft PR,
  // then merge + deploy when configured). Say so at kickoff, before it happens.
  const cfg = repoConfig(repoPath); // kept for branchPrefix reuse below
  // The cap must come from the config the RUN will read: its worktree checkout holds the
  // committed .autodev.json, not this folder's working copy (an uncommitted "push": false
  // must not silence the warn for a run that will push). --branch adopts another branch's
  // checkout, so the cap reads that branch's config, not HEAD's.
  let headCfg = {};
  try { headCfg = JSON.parse(execFileSync('git', ['show', `${branchArg || 'HEAD'}:.autodev.json`],
    { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true })); } catch {}
  const cap = untilStage(headCfg, until);
  if (cap >= stageN('push')) {
    const acts = ['push a branch and open a draft PR on origin'];
    if (headCfg.deploy && cap >= stageN('deploy'))
      acts.push(headCfg.deploy.merge !== false ? 'MERGE that PR and deploy' : 'run the deploy command');
    console.log(`[ WARN ] autonomous endpoint: this run will ${acts.join(', then ')} (cap it with --until verify, --no-push, or "push": false in .autodev.json)`);
  }

  // Jira mode: "autodev run CV-123" (or a browse URL) — resolve the ticket into the
  // requirement before anything else, so spec matching and slug use the real summary.
  // --issue-ref (jira-queue kickoffs) carries the requirement inline: record the key
  // for the dashboard's ticket link, but never fetch.
  const fetchKey = (issueRef || plainIssueRef) ? null : parseJiraRef(requirement);
  // A requirement that opens with a key ("SCRUM-75: …") is *for* that ticket even though it is
  // not fetched: record it, or the Deploy stage ships and the queue has no ticket to close.
  const jiraKey = fetchKey ?? (plainIssueRef ? parseJiraRef(plainIssueRef) : null) ?? leadingJiraKey(requirement);
  let issueType = null, slugSource = slugPrefix ?? requirement;
  if (fetchKey) {
    console.log(`fetching ${jiraKey} via atlassian-jira MCP…`);
    const issue = fetchIssue(jiraKey); // throws with a clear re-auth hint on failure
    requirement = issue.requirement;
    issueType = issue.type;
    slugSource = `${jiraKey} ${issue.summary}`;
    console.log(`${jiraKey} [${issue.type}] ${issue.summary}`);
  }

  // Resolve spec adoption before touching git/db so an invalid --spec creates nothing.
  // Stored/printed POSIX-style even on Windows — it's a repo-relative path, not an OS path.
  const toPosix = (p) => p.replaceAll('\\', '/');
  let adoptedSpec = null; // repo-relative path, e.g. "specs/001-rate-limit"
  if (specArg) {
    const specAbs = resolve(repoPath, specArg);
    if (!isCompleteSpecDir(specAbs)) {
      console.error(`--spec ${specArg} is not a complete spec dir (needs non-empty spec.md, plan.md, tasks.md)`);
      process.exit(1);
    }
    adoptedSpec = toPosix(relative(repoPath, specAbs));
  } else {
    const found = specDirFor(repoPath, requirement);
    if (found) adoptedSpec = toPosix(relative(repoPath, found));
  }

  await ensureServer();
  const repo = basename(repoPath);
  const db = openDb();
  const slug = slugify(slugSource);
  // Reserve the row FIRST: SQLite's AUTOINCREMENT is the only collision-free source of a
  // run number. Deriving it from a prior SELECT was wrong twice over — it raced concurrent
  // kickoffs, and because listRuns() sorts RUNNING before DONE it could hand back an id
  // that was not the maximum at all (one RUNNING run #3 alongside a finished #10 yields
  // 004, whose branch/worktree already exist). Naming from the inserted id also keeps the
  // NNN in autodev/NNN-slug equal to the run id the dashboard and `autodev status` show.
  const id = createRun(db, { slug, repo, repo_path: repoPath, worktree: '', branch: '', requirement,
    jira_key: jiraKey, issue_type: issueType, test_cmd: testCmd, until_stage: until,
    // issue_ref is what the Jira queue reconciles on; a leading key in the requirement counts.
    issue_ref: issueRef ?? plainIssueRef ?? jiraKey,
    // Persist the adoption, don't just print it: every stage resolves the spec through this,
    // and without it they each re-pick the highest-numbered directory instead (FR-019).
    // A run whose opening stages are pre-skipped must start past them, not on one it will never run.
    spec_dir: adoptedSpec, skipped: skip.length ? skip.join(',') : null,
    stage: (() => { let s = adoptedSpec ? 2 : 1; while (skip.includes(s)) s++; return s; })() });
  const nnn = String(id).padStart(3, '0');
  const branch = branchArg || `${cfg.branchPrefix || 'autodev'}/${nnn}-${slug}`;
  const wtRoot = process.env.AUTODEV_WORKTREES || join(homedir(), 'worktrees');
  const worktree = join(wtRoot, repo, `run-${nnn}`);
  mkdirSync(dirname(worktree), { recursive: true });
  // --branch adopts an existing branch (local, or remote-tracking via git DWIM) into the
  // worktree — no -b. Default mints a fresh autodev/NNN-slug branch off the repo's HEAD.
  const wtAddArgs = branchArg
    ? ['worktree', 'add', worktree, branch]
    : ['worktree', 'add', '-b', branch, worktree];
  try { execFileSync('git', wtAddArgs, { cwd: repoPath, windowsHide: true }); }
  catch (e) { // a failed kickoff must leave no ghost row behind — same as before the reserve
    deleteRun(db, id); db.close();
    console.error(`git worktree add failed: ${e.message}`);
    process.exit(1);
  }
  // A fresh worktree is TRACKED files only, and the build config a repo needs (SDK paths,
  // .env, keystores; typically gitignored) is exactly what never arrives. worktreeCopy is the
  // explicit allowlist: entries move because the operator named them, never because a
  // heuristic found them. Missing entries are noted, not fatal; entries escaping the repo are
  // refused; entries already tracked are skipped (the worktree already has the committed
  // copy, and overwriting it would put an uncommitted local change into a branch the run
  // commits and pushes); a copy that fails degrades to today's behavior rather than aborting
  // the whole kickoff.
  // .autodev.json only - no CLI flag, no env var; default [].
  const copyList = repoConfig(repoPath).worktreeCopy;
  const copyArr = Array.isArray(copyList) ? copyList : [];
  // Escape-check before the batched git call: an out-of-repo or empty pathspec makes
  // `git ls-files` fail outright ("fatal: ... is outside repository"), which would blank
  // the tracked set for every entry in the batch, not just the offending one.
  const inRepo = copyArr.filter(rel => {
    if (isAbsolute(rel)) return false;
    const relN = relative(repoPath, join(repoPath, rel));
    return relN && !relN.startsWith('..');
  // :(literal) so a leading ':' or a '*' in an entry cannot act as pathspec magic and
  // fail (or over-match) the whole batch; normalized so the key matches ls-files output.
  }).map(rel => `:(literal)${relative(repoPath, join(repoPath, rel)).replaceAll('\\', '/')}`);
  let tracked = new Set();
  if (inRepo.length) {
    try {
      tracked = new Set(execFileSync('git', ['ls-files', '--', ...inRepo],
        { cwd: repoPath, encoding: 'utf8', windowsHide: true }).split('\n').filter(Boolean));
    } catch { /* ls-files failing just means nothing is treated as tracked */ }
  }
  for (const rel of copyArr) {
    const src = join(repoPath, rel);
    const relN = relative(repoPath, src);
    if (isAbsolute(rel) || !relN || relN.startsWith('..')) {
      console.log(`worktreeCopy: ${rel} escapes the repo, skipped`); continue;
    }
    // Normalized ('./x' -> 'x', 'sub/' -> 'sub'), matching what ls-files prints: a raw
    // './x' key would miss the tracked set and reopen the overwrite the skip prevents.
    const relPosix = relN.replaceAll('\\', '/');
    if (!existsSync(src)) { console.log(`worktreeCopy: ${rel} not present, skipped`); continue; }
    if (tracked.has(relPosix) || [...tracked].some(t => t.startsWith(`${relPosix}/`))) {
      console.log(`worktreeCopy: ${rel} is tracked, the worktree already has it, skipped`); continue;
    }
    try {
      mkdirSync(dirname(join(worktree, rel)), { recursive: true });
      // dereference: true copies file content, never a live symlink pointer, which could
      // point outside the repo; it also sidesteps Windows symlink creation needing
      // privileges a build-config copy should never require.
      cpSync(src, join(worktree, rel), { recursive: true, dereference: true });
      // Sessions run `git add -A`, so an unexcluded copy would ride the stage-5 push.
      // The exclude file is the repo-wide .git/info/exclude (git shares info/ across
      // worktrees; there is no per-worktree exclude) - same mechanism as the holdout
      // sequester. Append-once: runs repeat, the exclude list must not grow with them.
      // Own catch: a copy that LANDED must never be reported as skipped.
      try {
        const exclude = resolve(worktree, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'],
          { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim());
        mkdirSync(dirname(exclude), { recursive: true }); // git init --template= can omit .git/info
        const line = `/${relPosix}`;
        if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes(line))
          appendFileSync(exclude, `${line}\n`);
      } catch (e) {
        console.log(`worktreeCopy: ${rel} copied but could NOT be git-excluded (${e.code ?? e.message}); git add will see it`);
      }
      console.log(`worktreeCopy: ${rel} -> worktree`);
    } catch (e) {
      console.log(`worktreeCopy: ${rel} could not be copied (${e.code ?? e.message}), skipped`);
    }
  }
  updateRun(db, id, { branch, worktree });
  db.close();
  mkdirSync(runDir(id), { recursive: true });
  if (!noSpawn) spawnRunner(id);
  console.log(`run #${id} started — ${branch}\nworktree: ${worktree}\ndashboard: ${base()}/`);
  if (adoptedSpec) console.log(`adopting existing spec: ${adoptedSpec} (starting at Analyze)`);
} else if (cmd === 'init') {
  // Scaffold the guidance layer in the TARGET repo. Templates, not defaults: an unedited
  // mission.md that rejects nothing is honest, and better than one that guesses the repo's
  // non-goals and starts declining work the operator wanted.
  const repoPath = resolve(rest[0] === '--repo' ? rest[1] : rest[0] ?? process.cwd());
  const files = [
    ['.autodev/mission.md', `# Mission

One paragraph: what this repository is for.

## Goals

- …

## Non-goals

- …

Anything a spec stage judges to be a non-goal is REJECTED before any code is written,
so this list is the only mechanism autodev has for telling you no. An empty non-goals
list means nothing is ever out of scope.
`],
    ['.autodev/factory-rules.md', `# Factory rules

Binding on every autodev session in this repository. These are stricter than CLAUDE.md
on purpose: CLAUDE.md governs work a human is watching, and this file governs work
nobody is watching.

- One task at a time. If a task cannot be finished and verified in one pass, split it.
- Never weaken, skip, or delete a test to make a suite green.
- Never widen the blast radius beyond what the spec asks for — no drive-by refactors.
- Prefer the boring change. An unsupervised clever change has no reviewer.
- If the requirement and the code disagree about intent, stop and say so in the spec
  rather than guessing.
`],
  ];
  let wrote = 0;
  for (const [rel, body] of files) {
    const dest = join(repoPath, rel);
    if (existsSync(dest)) { console.log(`kept    ${rel} (already exists)`); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    console.log(`created ${rel}`);
    wrote++;
  }
  console.log(wrote
    ? '\nedit both, commit them, and the next run will read them.'
    : '\nnothing to do — the guidance layer is already in place.');
} else if (cmd === 'daemon') {
  const arg = (flag, dflt) => { const i = rest.indexOf(flag); return i === -1 ? dflt : rest[i + 1]; };
  const repoPath = resolve(arg('--repo', process.cwd()));
  try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'ignore', windowsHide: true }); }
  catch { console.error(`not a git repository: ${repoPath}`); process.exit(1); }
  await ensureConsent(); // the daemon starts runs unattended — consent cannot be deferred to one
  await ensureServer();
  const { daemon } = await import('../src/daemon.js');
  await daemon({
    repoPath,
    intervalMin: Number(arg('--interval', 30)),
    maxParallel: Number(arg('--max-parallel', 2)),
    autoAccept: rest.includes('--auto-accept'),
    once: rest.includes('--once'),
    cliPath: fileURLToPath(import.meta.url),
  });
} else if (cmd === 'status') {
  const db = openDb();
  const runs = listRuns(db);
  db.close();
  // Denominator per repo, not global: a repo without a deploy config has a 7-stage pipeline
  // and "stage 7/8" would read as unfinished forever.
  for (const r of runs) {
    const total = scheduledStages(repoConfig(r.repo_path)).length;
    const mark = r.status === 'REJECTED' ? '  ✕ ' : '  ⚠ ';
    console.log(`#${String(r.id).padStart(3, '0')} ${r.status.padEnd(8)} stage ${r.stage}/${total}  ${r.repo}  ${r.slug}${r.blocked_reason ? mark + r.blocked_reason : ''}`);
  }
} else if (cmd === 'resume') {
  const id = Number(rest[0]);
  await ensureServer();
  spawnRunner(id, ['--resume']);
  console.log(`run #${id} resuming`);
} else if (cmd === 'stop') {
  const id = Number(rest[0]);
  const db = openDb();
  const run = getRun(db, id);
  if (!run) { console.error(`no run ${id}`); db.close(); process.exit(1); }
  // runner is spawned detached (its own process-group leader) and runs claude in that
  // same group via execFileSync — killing only the runner pid leaves claude running.
  if (run.pid) {
    if (process.platform === 'win32') {
      // negative-PID group kill is POSIX-only; taskkill /T fells the whole process tree
      try { execFileSync('taskkill', ['/pid', String(run.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    } else {
      try { process.kill(-run.pid, 'SIGTERM'); }
      catch { try { process.kill(run.pid); } catch {} }
    }
  }
  updateRun(db, id, { status: 'BLOCKED', blocked_reason: 'stopped by user' });
  db.close();
  await emit({ runDir: runDir(id), port: PORT() }, { run: id, type: 'parked', stage: run.stage, detail: 'stopped by user' });
  console.log(`run #${id} stopped`);
} else if (cmd === 'cost') {
  const id = Number(rest[0]);
  const p = join(runDir(id), 'events.jsonl');
  if (!id || !existsSync(p)) { console.error(`no events for run ${rest[0] ?? '?'}`); process.exit(1); }
  const per = new Map(); // stage → {calls, in, out, cost}
  for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'metrics') continue;
    const s = per.get(e.stage) ?? { calls: 0, tin: 0, tout: 0, cost: 0, models: new Set() };
    s.calls++; s.tin += e.tokens_in ?? 0; s.tout += e.tokens_out ?? 0; s.cost += e.cost_usd ?? 0;
    if (e.model) s.models.add(e.model);
    per.set(e.stage, s);
  }
  let tot = { calls: 0, tin: 0, tout: 0, cost: 0 };
  for (const [n, s] of [...per.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`stage ${n} ${(STAGES[n - 1]?.title ?? '?').padEnd(10)} ${String(s.calls).padStart(2)} session(s)  in ${String(s.tin).padStart(9)}  out ${String(s.tout).padStart(8)}  $${s.cost.toFixed(2)}  ${[...s.models].join(' + ')}`);
    tot.calls += s.calls; tot.tin += s.tin; tot.tout += s.tout; tot.cost += s.cost;
  }
  console.log(`total            ${String(tot.calls).padStart(2)} session(s)  in ${String(tot.tin).padStart(9)}  out ${String(tot.tout).padStart(8)}  $${tot.cost.toFixed(2)}`);
} else if (cmd === 'selftest') {
  const { selftest } = await import('../src/selftest.js');
  process.exit((await selftest()) ? 0 : 1);
} else if (cmd === 'doctor') {
  const repoArg = rest[0] === '--repo' ? rest[1] : rest[0];
  const failures = printChecks(await doctor(repoArg ? resolve(repoArg) : process.cwd()));
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
} else if (cmd === 'install-skill' || cmd === 'uninstall-skill') {
  // --project installs into ./.claude/skills (this repo only) instead of ~/.claude/skills
  // (every project on the machine) — autodev-specs matches generic "write a spec" asks,
  // so machine-global install is a deliberate choice, not the silent default consequence.
  const root = rest.includes('--project')
    ? join(process.cwd(), '.claude', 'skills') : join(homedir(), '.claude', 'skills');
  const force = rest.includes('--force');
  // [repo path under skill/, installed skill name]
  const skills = [['SKILL.md', 'autodev'], [join('autodev-specs', 'SKILL.md'), 'autodev-specs']];
  for (const [src, name] of skills) {
    const dest = join(root, name, 'SKILL.md');
    if (cmd === 'uninstall-skill') {
      rmSync(join(root, name), { recursive: true, force: true });
      console.log(`removed skill: ${join(root, name)}`);
      continue;
    }
    const srcBody = readFileSync(join(ROOT, 'skill', src), 'utf8');
    if (existsSync(dest) && readFileSync(dest, 'utf8') !== srcBody && !force) {
      console.error(`SKIPPED ${dest} — exists with different content (edited or another tool's skill). Re-run with --force to overwrite.`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, 'skill', src), dest);
    console.log(`installed skill: ${dest}`);
  }
} else {
  console.log(USAGE);
}
