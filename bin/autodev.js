#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { PORT, runDir, openDb, createRun, getRun, listRuns, updateRun, AUTODEV_HOME } from '../src/db.js';
import { emit } from '../src/events.js';
import { specDirFor, isCompleteSpecDir, STAGES, stageN } from '../src/stages.js';
import { parseJiraRef, fetchIssue } from '../src/jira.js';
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
    spawn('node', [join(ROOT, 'src/server.js')], { detached: true, stdio: ['ignore', log, log] }).unref();
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
  spawn('node', [join(ROOT, 'src/runner.js'), String(id), ...extra],
    { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
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
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') { repoPath = args[++i]; }
    else if (a === '--spec') { specArg = args[++i]; }
    else if (a === '--branch') { branchArg = args[++i]; }
    else if (a === '--test-cmd') { testCmd = args[++i]; }
    else if (a === '--until') {
      until = stageN(args[++i]);
      if (!until) { console.error(`--until wants a stage 1-${STAGES.length} or a name: ${STAGES.map(s => s.key).join('|')}`); process.exit(1); }
    }
    else if (a === '--no-push') { until = stageN('verify'); } // stop before anything leaves the machine
    else if (a === '--no-spawn') { noSpawn = true; }
    else words.push(a);
  }
  return { requirement: words.join(' '), repoPath: resolve(repoPath), noSpawn, specArg, branchArg, testCmd, until };
}

if (cmd === 'run') {
  let { requirement, repoPath, noSpawn, specArg, branchArg, testCmd, until } = parseRunArgs(rest);
  if (!requirement) { console.error('usage: autodev run "<requirement>"|<JIRA-KEY> [--repo <path>] [--spec <path>] [--branch <name>] [--test-cmd <cmd>] [--until <stage>] [--no-push]'); process.exit(1); }

  await ensureConsent();
  // Preflight — a stranger's first failure should cost five seconds, not a parked run.
  const failures = printChecks((await doctor(repoPath)).filter(c => c.severity !== 'pass'));
  if (failures.length) { console.error(`\n${failures.length} preflight check(s) failed — fix and re-run (autodev doctor to re-check)`); process.exit(1); }

  // Jira mode: "autodev run CV-123" (or a browse URL) — resolve the ticket into the
  // requirement before anything else, so spec matching and slug use the real summary.
  const jiraKey = parseJiraRef(requirement);
  let issueType = null, slugSource = requirement;
  if (jiraKey) {
    console.log(`fetching ${jiraKey} via atlassian-jira MCP…`);
    const issue = fetchIssue(jiraKey); // throws with a clear re-auth hint on failure
    requirement = issue.requirement;
    issueType = issue.type;
    slugSource = `${jiraKey} ${issue.summary}`;
    console.log(`${jiraKey} [${issue.type}] ${issue.summary}`);
  }

  // Resolve spec adoption before touching git/db so an invalid --spec creates nothing.
  let adoptedSpec = null; // repo-relative path, e.g. "specs/001-rate-limit"
  if (specArg) {
    const specAbs = resolve(repoPath, specArg);
    if (!isCompleteSpecDir(specAbs)) {
      console.error(`--spec ${specArg} is not a complete spec dir (needs non-empty spec.md, plan.md, tasks.md)`);
      process.exit(1);
    }
    adoptedSpec = relative(repoPath, specAbs);
  } else {
    const found = specDirFor(repoPath, requirement);
    if (found) adoptedSpec = relative(repoPath, found);
  }

  await ensureServer();
  const repo = basename(repoPath);
  const db = openDb();
  // provisional id = current max + 1
  // ponytail: can race with a concurrent kickoff — accepted for now, no locking.
  const runs = listRuns(db);
  const nnn = String((runs[0]?.id ?? 0) + 1).padStart(3, '0');
  const slug = slugify(slugSource);
  const branch = branchArg || `${repoConfig(repoPath).branchPrefix || 'autodev'}/${nnn}-${slug}`;
  const wtRoot = process.env.AUTODEV_WORKTREES || join(homedir(), 'worktrees');
  const worktree = join(wtRoot, repo, `run-${nnn}`);
  mkdirSync(dirname(worktree), { recursive: true });
  // --branch adopts an existing branch (local, or remote-tracking via git DWIM) into the
  // worktree — no -b. Default mints a fresh autodev/NNN-slug branch off the repo's HEAD.
  const wtAddArgs = branchArg
    ? ['worktree', 'add', worktree, branch]
    : ['worktree', 'add', '-b', branch, worktree];
  execFileSync('git', wtAddArgs, { cwd: repoPath });
  const id = createRun(db, { slug, repo, repo_path: repoPath, worktree, branch, requirement,
    jira_key: jiraKey, issue_type: issueType, test_cmd: testCmd, until_stage: until, stage: adoptedSpec ? 2 : 1 });
  db.close();
  mkdirSync(runDir(id), { recursive: true });
  if (!noSpawn) spawnRunner(id);
  console.log(`run #${id} started — ${branch}\nworktree: ${worktree}\ndashboard: ${base()}/`);
  if (adoptedSpec) console.log(`adopting existing spec: ${adoptedSpec} (starting at Analyze)`);
} else if (cmd === 'status') {
  const db = openDb();
  const runs = listRuns(db);
  db.close();
  for (const r of runs) console.log(`#${String(r.id).padStart(3, '0')} ${r.status.padEnd(8)} stage ${r.stage}/${STAGES.length}  ${r.repo}  ${r.slug}${r.blocked_reason ? '  ⚠ ' + r.blocked_reason : ''}`);
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
      try { execFileSync('taskkill', ['/pid', String(run.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
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
  console.log('usage: autodev run "<requirement>" [--repo <path>] [--spec <path>] [--branch <name>] [--test-cmd <cmd>] [--until <stage>] [--no-push] | status | resume <id> | stop <id> | cost <id> | doctor [path] | selftest | install-skill [--project] [--force] | uninstall-skill [--project]');
}
