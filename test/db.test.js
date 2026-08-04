import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

test('spec_dir round-trips and defaults to null', () => {
  const pinned = createRun(db, { slug: 's', repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b',
    requirement: 'q', spec_dir: 'specs/004-marketplace' });
  assert.equal(getRun(db, pinned).spec_dir, 'specs/004-marketplace');
  const loose = createRun(db, { slug: 's', repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b', requirement: 'q' });
  assert.equal(getRun(db, loose).spec_dir, null, 'unpinned means "resolve as before"');
});

test('a database written before spec_dir existed opens, migrates and reads', () => {
  // Build the pre-change schema by hand, insert a row, then open it with the current code.
  const path = join(process.env.AUTODEV_HOME, `legacy${Math.random()}.db`);
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL, repo TEXT NOT NULL, repo_path TEXT NOT NULL,
    worktree TEXT NOT NULL, branch TEXT NOT NULL, requirement TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING', stage INTEGER NOT NULL DEFAULT 1,
    pid INTEGER, pr_url TEXT, blocked_reason TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  legacy.exec(`INSERT INTO runs (slug, repo, repo_path, worktree, branch, requirement, created_at, updated_at)
    VALUES ('old','r','/p','/w','b','q',1,1)`);
  legacy.close();

  const migrated = openDb(path);
  const run = getRun(migrated, 1);
  assert.equal(run.slug, 'old');
  assert.equal(run.spec_dir, null);
  assert.equal(run.until_stage, null); // the whole migration loop still runs
  migrated.close();
});

test('listRuns surfaces in-progress runs above blocked/done, even when older', () => {
  const mk = (slug) => createRun(db, { slug, repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b', requirement: 'q' });
  updateRun(db, mk('running'), { status: 'RUNNING' }); // oldest, still in progress
  updateRun(db, mk('blocked'), { status: 'BLOCKED' });
  updateRun(db, mk('done'),    { status: 'DONE' });    // newest
  assert.deepEqual(listRuns(db).map(r => r.slug), ['running', 'blocked', 'done']);
});
