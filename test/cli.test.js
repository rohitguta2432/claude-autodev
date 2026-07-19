import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync, spawn } from 'node:child_process';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-cli-'));
process.env.AUTODEV_PORT = '0'; // test provides its own server port below
process.env.AUTODEV_WORKTREES = mkdtempSync(join(tmpdir(), 'wts-'));

const { startServer } = await import('../src/server.js');
const { openDb, getRun, createRun, runDir } = await import('../src/db.js');
const { port, close } = await startServer({ port: 0 });
process.env.AUTODEV_PORT = String(port);

// stub claude that instantly succeeds nothing (runner will park; we only test kickoff mechanics)
const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
writeFileSync(join(stubDir, 'claude'), '#!/usr/bin/env bash\nexit 0');
chmodSync(join(stubDir, 'claude'), 0o755);
process.env.AUTODEV_CLAUDE_BIN = join(stubDir, 'claude');

test('autodev run creates worktree, branch, registers run, spawns runner', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: repo, shell: '/bin/bash' });
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'add a health endpoint', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.match(out, /run #1/i);
  const db = openDb();
  const run = getRun(db, 1); db.close();
  assert.equal(run.status, 'RUNNING');
  assert.match(run.branch, /^autodev\/001-/);
  assert.match(readFileSync(join(run.worktree, '.git'), 'utf8'), /gitdir/); // it's a worktree
  const branches = execSync('git branch --list', { cwd: run.worktree, encoding: 'utf8' });
  assert.match(branches, /autodev\/001-/);
  close();
});

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn, ms = 5000, step = 50) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise(r => setTimeout(r, step));
  }
}

test('stop kills the runner\'s whole process group, including the claude child', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'wt-stop-'));
  const db = openDb();
  const id = createRun(db, { slug: 'stop-test', repo: 'demo', repo_path: worktree, worktree, branch: 'autodev/stop-test', requirement: 'q' });
  db.close();
  mkdirSync(runDir(id), { recursive: true });

  // stub claude that records its own pid (bash's, since there's no exec) then sleeps —
  // simulating a long-running edit/commit/push session still in the runner's process group.
  const pidFile = join(worktree, 'claude.pid');
  const stubDir2 = mkdtempSync(join(tmpdir(), 'stub-sleep-'));
  writeFileSync(join(stubDir2, 'claude'), `#!/usr/bin/env bash\necho $$ > ${pidFile}\nsleep 30\n`);
  chmodSync(join(stubDir2, 'claude'), 0o755);

  const log = openSync(join(runDir(id), 'runner.log'), 'a');
  const runner = spawn('node', ['src/runner.js', String(id)],
    { detached: true, stdio: ['ignore', log, log], env: { ...process.env, AUTODEV_CLAUDE_BIN: join(stubDir2, 'claude') } });
  runner.unref();
  const runnerPid = runner.pid;

  // wait for claude (the stub) to actually be running before we try to stop it
  const claudePid = await waitFor(() => {
    try { return Number(readFileSync(pidFile, 'utf8').trim()) || null; } catch { return null; }
  });
  assert.ok(isAlive(runnerPid), 'runner should still be alive before stop');
  assert.ok(isAlive(claudePid), 'claude stub should still be alive before stop');

  execFileSync('node', ['bin/autodev.js', 'stop', String(id)], { encoding: 'utf8' });

  await waitFor(() => !isAlive(runnerPid) && !isAlive(claudePid) ? true : null);
  assert.ok(!isAlive(runnerPid), 'runner should be dead after stop');
  assert.ok(!isAlive(claudePid), 'claude stub should be dead after stop (not orphaned)');
});
