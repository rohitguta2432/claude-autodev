import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-cli-'));
process.env.AUTODEV_PORT = '0'; // test provides its own server port below
process.env.AUTODEV_WORKTREES = mkdtempSync(join(tmpdir(), 'wts-'));

const { startServer } = await import('../src/server.js');
const { openDb, getRun } = await import('../src/db.js');
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
