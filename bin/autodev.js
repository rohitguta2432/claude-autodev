#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { PORT, runDir, openDb, createRun, getRun, listRuns, updateRun } from '../src/db.js';
import { emit } from '../src/events.js';
import { specDirFor, isCompleteSpecDir, STAGES } from '../src/stages.js';
import { parseJiraRef, fetchIssue } from '../src/jira.js';

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
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') { repoPath = args[++i]; }
    else if (a === '--spec') { specArg = args[++i]; }
    else if (a === '--branch') { branchArg = args[++i]; }
    else if (a === '--test-cmd') { testCmd = args[++i]; }
    else if (a === '--no-spawn') { noSpawn = true; }
    else words.push(a);
  }
  return { requirement: words.join(' '), repoPath: resolve(repoPath), noSpawn, specArg, branchArg, testCmd };
}

if (cmd === 'run') {
  let { requirement, repoPath, noSpawn, specArg, branchArg, testCmd } = parseRunArgs(rest);
  if (!requirement) { console.error('usage: autodev run "<requirement>"|<JIRA-KEY> [--repo <path>] [--spec <path>] [--branch <name>] [--test-cmd <cmd>]'); process.exit(1); }

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
  const branch = branchArg || `autodev/${nnn}-${slug}`;
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
    jira_key: jiraKey, issue_type: issueType, test_cmd: testCmd, stage: adoptedSpec ? 2 : 1 });
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
    try { process.kill(-run.pid, 'SIGTERM'); }
    catch { try { process.kill(run.pid); } catch {} }
  }
  updateRun(db, id, { status: 'BLOCKED', blocked_reason: 'stopped by user' });
  db.close();
  await emit({ runDir: runDir(id), port: PORT() }, { run: id, type: 'parked', stage: run.stage, detail: 'stopped by user' });
  console.log(`run #${id} stopped`);
} else if (cmd === 'install-skill') {
  // [repo path under skill/, installed skill name]
  for (const [src, name] of [['SKILL.md', 'autodev'], [join('specs-skill', 'SKILL.md'), 'specs-skill']]) {
    const dest = join(homedir(), '.claude', 'skills', name, 'SKILL.md');
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, 'skill', src), dest);
    console.log(`installed skill: ${dest}`);
  }
} else {
  console.log('usage: autodev run "<requirement>" [--repo <path>] [--spec <path>] [--branch <name>] [--test-cmd <cmd>] | status | resume <id> | stop <id> | install-skill');
}
