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
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  return db;
}

export function createRun(db, r) {
  const now = Date.now();
  const res = db.prepare(`INSERT INTO runs
    (slug, repo, repo_path, worktree, branch, requirement, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(r.slug, r.repo, r.repo_path, r.worktree, r.branch, r.requirement, now, now);
  return Number(res.lastInsertRowid);
}

export const getRun = (db, id) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
export const listRuns = (db) => db.prepare('SELECT * FROM runs ORDER BY id DESC').all();

export function updateRun(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE runs SET ${set}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(k => fields[k]), Date.now(), id);
}
