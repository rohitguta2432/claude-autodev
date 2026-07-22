import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, openSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { git, commit, stubClaude } from './helpers.js';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-cli-'));
process.env.AUTODEV_PORT = '0'; // test provides its own server port below
process.env.AUTODEV_WORKTREES = mkdtempSync(join(tmpdir(), 'wts-'));

const { startServer } = await import('../src/server.js');
const { openDb, getRun, createRun, listRuns, runDir } = await import('../src/db.js');
const { port, close } = await startServer({ port: 0 });
process.env.AUTODEV_PORT = String(port);

// stub claude that instantly succeeds nothing (runner will park; we only test kickoff mechanics)
const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
process.env.AUTODEV_CLAUDE_BIN = stubClaude(stubDir, '');

test('autodev run creates worktree, branch, registers run, spawns runner', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
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

function repoWithCompleteSpec() {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main']);
  mkdirSync(join(repo, 'specs/001-rate-limit'), { recursive: true });
  writeFileSync(join(repo, 'specs/001-rate-limit/spec.md'), '# spec\n');
  writeFileSync(join(repo, 'specs/001-rate-limit/plan.md'), '# plan\n');
  writeFileSync(join(repo, 'specs/001-rate-limit/tasks.md'), '- [ ] T001 x\n');
  git(repo, ['add', '-A'], commit('init'));
  return repo;
}

test('autodev run auto-adopts a matching complete spec and starts at stage 2', () => {
  const repo = repoWithCompleteSpec();
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'add rate limit to api', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.match(out, /adopting existing spec: specs\/001-rate-limit \(starting at Analyze\)/);
  const db = openDb();
  const run = listRuns(db)[0];
  db.close();
  assert.equal(run.stage, 2);
});

test('autodev run leaves stage 1 and prints nothing extra when requirement does not match any spec', () => {
  const repo = repoWithCompleteSpec();
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'build an unrelated dashboard widget', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.doesNotMatch(out, /adopting existing spec/);
  const db = openDb();
  const run = listRuns(db)[0];
  db.close();
  assert.equal(run.stage, 1);
});

test('autodev run --spec <path> pointing at incomplete dir fails cleanly: exit non-zero, no run row, no worktree', () => {
  const repo = repoWithCompleteSpec();
  writeFileSync(join(repo, 'specs/001-rate-limit/tasks.md'), ''); // make it incomplete
  git(repo, ['add', '-A'], commit('incomplete'));
  const db = openDb();
  const before = listRuns(db).length;
  db.close();
  assert.throws(() => execFileSync('node', ['bin/autodev.js', 'run', 'add rate limit', '--repo', repo, '--spec', 'specs/001-rate-limit', '--no-spawn'], { encoding: 'utf8', stdio: 'pipe' }));
  const db2 = openDb();
  const after = listRuns(db2).length;
  db2.close();
  assert.equal(after, before);
  assert.ok(!existsSync(join(process.env.AUTODEV_WORKTREES, basename(repo))));
});

test('autodev install-skill copies autodev + specs-skill into ~/.claude/skills/', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  execFileSync('node', ['bin/autodev.js', 'install-skill'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  const dest = join(home, '.claude/skills/autodev/SKILL.md');
  assert.ok(existsSync(dest));
  assert.equal(readFileSync(dest, 'utf8'), readFileSync('skill/SKILL.md', 'utf8'));
  const specDest = join(home, '.claude/skills/specs-skill/SKILL.md');
  assert.ok(existsSync(specDest));
  assert.equal(readFileSync(specDest, 'utf8'), readFileSync('skill/specs-skill/SKILL.md', 'utf8'));
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

  // stub claude that records its own pid then sleeps — simulating a long-running
  // edit/commit/push session still in the runner's process group.
  const pidFile = join(worktree, 'claude.pid');
  const stubDir2 = mkdtempSync(join(tmpdir(), 'stub-sleep-'));
  const sleepStub = stubClaude(stubDir2,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`);

  const log = openSync(join(runDir(id), 'runner.log'), 'a');
  const runner = spawn('node', ['src/runner.js', String(id)],
    { detached: true, stdio: ['ignore', log, log], env: { ...process.env, AUTODEV_CLAUDE_BIN: sleepStub } });
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

test('autodev run --test-cmd stores the override on the run row', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  execFileSync('node', ['bin/autodev.js', 'run', 'health endpoint two', '--repo', repo, '--no-spawn', '--test-cmd', 'make check'], { encoding: 'utf8' });
  const db = openDb();
  const run = listRuns(db)[0]; db.close();
  assert.equal(run.test_cmd, 'make check');
});

test('autodev run --no-push and --until store the stage cap; bad --until exits', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  execFileSync('node', ['bin/autodev.js', 'run', 'capped run one', '--repo', repo, '--no-spawn', '--no-push'], { encoding: 'utf8' });
  const db = openDb();
  assert.equal(listRuns(db)[0].until_stage, 4); db.close();
  execFileSync('node', ['bin/autodev.js', 'run', 'capped run two', '--repo', repo, '--no-spawn', '--until', 'analyze'], { encoding: 'utf8' });
  const db2 = openDb();
  assert.equal(listRuns(db2)[0].until_stage, 2); db2.close();
  assert.throws(() => execFileSync('node', ['bin/autodev.js', 'run', 'x', '--repo', repo, '--no-spawn', '--until', 'nonsense'], { stdio: 'pipe' }), /--until wants/s);
});

test('run without recorded consent (real claude, no TTY) aborts and explains', () => {
  const env = { ...process.env, AUTODEV_HOME: mkdtempSync(join(tmpdir(), 'consent-')) };
  delete env.AUTODEV_CLAUDE_BIN; // real-claude mode → consent gate applies
  assert.throws(
    () => execFileSync('node', ['bin/autodev.js', 'run', 'x y z', '--no-spawn'], { env, stdio: 'pipe' }),
    /dangerously-skip-permissions[\s\S]*consent/);
});
