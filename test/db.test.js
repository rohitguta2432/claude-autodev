import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-db-'));
const { openDb, createRun, getRun, listRuns, updateRun } = await import('../src/db.js');

let db;
beforeEach(() => { db = openDb(join(process.env.AUTODEV_HOME, `t${Math.random()}.db`)); });

test('createRun returns incrementing id and getRun round-trips', () => {
  const id = createRun(db, {
    slug: 'rate-limit', repo: 'demo', repo_path: '/tmp/demo',
    worktree: '/tmp/wt', branch: 'autodev/001-rate-limit', requirement: 'add rate limiting',
  });
  assert.equal(id, 1);
  const run = getRun(db, 1);
  assert.equal(run.slug, 'rate-limit');
  assert.equal(run.status, 'RUNNING');
  assert.equal(run.stage, 1);
  assert.ok(run.created_at > 0);
});

test('createRun accepts an optional stage, defaulting to 1', () => {
  const id = createRun(db, { slug: 's', repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b', requirement: 'q', stage: 2 });
  assert.equal(getRun(db, id).stage, 2);
});

test('updateRun patches only given fields', () => {
  const id = createRun(db, { slug: 's', repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b', requirement: 'q' });
  updateRun(db, id, { status: 'BLOCKED', stage: 5, pid: 123 });
  const run = getRun(db, id);
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.stage, 5);
  assert.equal(run.pid, 123);
  assert.equal(run.slug, 's');
});

test('listRuns returns newest first', () => {
  createRun(db, { slug: 'a', repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b', requirement: 'q' });
  createRun(db, { slug: 'b', repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b', requirement: 'q' });
  assert.deepEqual(listRuns(db).map(r => r.slug), ['b', 'a']);
});

test('listRuns surfaces in-progress runs above blocked/done, even when older', () => {
  const mk = (slug) => createRun(db, { slug, repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b', requirement: 'q' });
  updateRun(db, mk('running'), { status: 'RUNNING' }); // oldest, still in progress
  updateRun(db, mk('blocked'), { status: 'BLOCKED' });
  updateRun(db, mk('done'),    { status: 'DONE' });    // newest
  assert.deepEqual(listRuns(db).map(r => r.slug), ['running', 'blocked', 'done']);
});
