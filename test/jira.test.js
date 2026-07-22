import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseJiraRef, fetchIssue } from '../src/jira.js';

test('parseJiraRef: keys and browse URLs, rejects free text', () => {
  assert.equal(parseJiraRef('CV-123'), 'CV-123');
  assert.equal(parseJiraRef('CVSX-9'), 'CVSX-9');
  assert.equal(parseJiraRef('https://jira.example.com/browse/CV-204'), 'CV-204');
  assert.equal(parseJiraRef('add rate limiting to the API'), null);
  assert.equal(parseJiraRef('fix CV-123 quickly'), null); // key embedded in prose is a requirement, not a ref
  assert.equal(parseJiraRef(''), null);
});

// Stub claude: echoes a canned Jira JSON (same AUTODEV_CLAUDE_BIN convention as runner tests).
function stubClaude(body) {
  const dir = mkdtempSync(join(tmpdir(), 'jira-stub-'));
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\necho '${body}'`);
  chmodSync(join(dir, 'claude'), 0o755);
  return join(dir, 'claude');
}

test('fetchIssue: parses issue JSON, classifies Bug, builds requirement', () => {
  process.env.AUTODEV_CLAUDE_BIN = stubClaude(
    '{"key":"CV-77","type":"Bug","summary":"NPE on empty payload","description":"Steps: send empty body. AC: 400 returned."}');
  const issue = fetchIssue('CV-77');
  assert.equal(issue.type, 'bug');
  assert.equal(issue.summary, 'NPE on empty payload');
  assert.match(issue.requirement, /^\[CV-77\] NPE on empty payload/);
  assert.match(issue.requirement, /AC: 400 returned/);
  delete process.env.AUTODEV_CLAUDE_BIN;
});

test('fetchIssue: Story classifies as feature; error JSON throws with re-auth hint', () => {
  process.env.AUTODEV_CLAUDE_BIN = stubClaude('{"key":"CV-8","type":"Story","summary":"Add cache"}');
  assert.equal(fetchIssue('CV-8').type, 'feature');
  process.env.AUTODEV_CLAUDE_BIN = stubClaude('{"error":"not authenticated"}');
  assert.throws(() => fetchIssue('CV-9'), /authenticate/i);
  delete process.env.AUTODEV_CLAUDE_BIN;
});

test('stage prompts branch on issue_type and carry the jira key', async () => {
  const { STAGES } = await import('../src/stages.js');
  const bug = { issue_type: 'bug', jira_key: 'CV-7', requirement: 'q', branch: 'b' };
  const feat = { issue_type: null, jira_key: null, requirement: 'q', branch: 'b' };
  assert.match(STAGES[0].prompt(bug), /FAILING regression test/);
  assert.doesNotMatch(STAGES[0].prompt(feat), /regression/);
  assert.match(STAGES[4].prompt(bug), /CV-7: /);
  assert.doesNotMatch(STAGES[4].prompt(feat), /Jira/);
});

test('openDb migrates a pre-jira schema in place', async () => {
  process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-jira-mig-'));
  const path = join(process.env.AUTODEV_HOME, 'autodev.db');
  const old = new DatabaseSync(path); // old schema without jira columns
  old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL, repo TEXT NOT NULL, repo_path TEXT NOT NULL,
    worktree TEXT NOT NULL, branch TEXT NOT NULL, requirement TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING', stage INTEGER NOT NULL DEFAULT 1,
    pid INTEGER, pr_url TEXT, blocked_reason TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  old.close();
  const { openDb, createRun, getRun } = await import('../src/db.js');
  const db = openDb(path);
  const id = createRun(db, { slug: 's', repo: 'r', repo_path: '/p', worktree: '/w', branch: 'b',
    requirement: 'q', jira_key: 'CV-1', issue_type: 'bug' });
  const run = getRun(db, id);
  assert.equal(run.jira_key, 'CV-1');
  assert.equal(run.issue_type, 'bug');
  db.close();
});
