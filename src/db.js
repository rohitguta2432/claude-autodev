import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const AUTODEV_HOME = () => process.env.AUTODEV_HOME || join(homedir(), '.autodev');
export const PORT = () => Number(process.env.AUTODEV_PORT || 4590);
export const runDir = (id) => join(AUTODEV_HOME(), 'runs', String(id));

export function openDb(path = join(AUTODEV_HOME(), 'autodev.db')) {
  mkdirSync(AUTODEV_HOME(), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL, repo TEXT NOT NULL, repo_path TEXT NOT NULL,
    worktree TEXT NOT NULL, branch TEXT NOT NULL, requirement TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING',
    stage INTEGER NOT NULL DEFAULT 1,
    pid INTEGER, pr_url TEXT, blocked_reason TEXT,
    jira_key TEXT, issue_type TEXT, skipped TEXT, test_cmd TEXT, until_stage INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  // migrate pre-existing DBs — ALTER is a no-op error when the column already exists
  for (const col of ['jira_key TEXT', 'issue_type TEXT', 'skipped TEXT', 'test_cmd TEXT', 'until_stage INTEGER']) {
    try { db.exec(`ALTER TABLE runs ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  return db;
}

export function createRun(db, r) {
  const now = Date.now();
  const res = db.prepare(`INSERT INTO runs
    (slug, repo, repo_path, worktree, branch, requirement, stage, jira_key, issue_type, test_cmd, until_stage, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.slug, r.repo, r.repo_path, r.worktree, r.branch, r.requirement, r.stage ?? 1,
         r.jira_key ?? null, r.issue_type ?? null, r.test_cmd ?? null, r.until_stage ?? null, now, now);
  return Number(res.lastInsertRowid);
}

export const getRun = (db, id) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
// Only for rolling back a reserved row whose kickoff then failed (see bin/autodev.js) —
// completed runs are history and are never deleted.
export const deleteRun = (db, id) => db.prepare('DELETE FROM runs WHERE id = ?').run(id);
// Stages the user skipped from the dashboard — stored as a comma-joined string on the run row.
export const skippedSet = (run) => new Set(String(run?.skipped || '').split(',').filter(Boolean).map(Number));
// In-progress first, then blocked, then everything else; newest-first within each group.
export const listRuns = (db) => db.prepare(
  `SELECT * FROM runs ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'BLOCKED' THEN 1 ELSE 2 END, id DESC`).all();

export function updateRun(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE runs SET ${set}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(k => fields[k]), Date.now(), id);
}
