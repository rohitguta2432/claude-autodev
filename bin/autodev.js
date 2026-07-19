#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { PORT, runDir, openDb, createRun, getRun, listRuns, updateRun } from '../src/db.js';
import { emit } from '../src/events.js';

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
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') { repoPath = args[++i]; }
    else if (a === '--no-spawn') { noSpawn = true; }
    else words.push(a);
  }
  return { requirement: words.join(' '), repoPath: resolve(repoPath), noSpawn };
}

if (cmd === 'run') {
  const { requirement, repoPath, noSpawn } = parseRunArgs(rest);
  if (!requirement) { console.error('usage: autodev run "<requirement>" [--repo <path>]'); process.exit(1); }
  await ensureServer();
  const repo = basename(repoPath);
  const db = openDb();
  // provisional id = current max + 1
  // ponytail: can race with a concurrent kickoff — accepted for now, no locking.
  const runs = listRuns(db);
  const nnn = String((runs[0]?.id ?? 0) + 1).padStart(3, '0');
  const slug = slugify(requirement);
  const branch = `autodev/${nnn}-${slug}`;
  const wtRoot = process.env.AUTODEV_WORKTREES || join(homedir(), 'worktrees');
  const worktree = join(wtRoot, repo, `run-${nnn}`);
  mkdirSync(dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, worktree], { cwd: repoPath });
  const id = createRun(db, { slug, repo, repo_path: repoPath, worktree, branch, requirement });
  db.close();
  mkdirSync(runDir(id), { recursive: true });
  if (!noSpawn) spawnRunner(id);
  console.log(`run #${id} started — ${branch}\nworktree: ${worktree}\ndashboard: ${base()}/`);
} else if (cmd === 'status') {
  const db = openDb();
  const runs = listRuns(db);
  db.close();
  for (const r of runs) console.log(`#${String(r.id).padStart(3, '0')} ${r.status.padEnd(8)} stage ${r.stage}/6  ${r.repo}  ${r.slug}${r.blocked_reason ? '  ⚠ ' + r.blocked_reason : ''}`);
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
  if (run.pid) { try { process.kill(run.pid); } catch {} }
  updateRun(db, id, { status: 'BLOCKED', blocked_reason: 'stopped by user' });
  db.close();
  await emit({ runDir: runDir(id), port: PORT() }, { run: id, type: 'parked', stage: run.stage, detail: 'stopped by user' });
  console.log(`run #${id} stopped`);
} else {
  console.log('usage: autodev run "<requirement>" [--repo <path>] | status | resume <id> | stop <id>');
}
