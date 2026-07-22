import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, commit, stubClaude, pipelineStubJs } from './helpers.js';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-run-'));
const { openDb, createRun, getRun, runDir } = await import('../src/db.js');

// Stub claude: reads the -p prompt, fabricates the right artifact per stage keyword.
const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
const stubPath = stubClaude(stubDir, pipelineStubJs(join(stubDir, 'calls')));
process.env.AUTODEV_CLAUDE_BIN = stubPath;

function makeRepoWithWorktree() {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  git(origin, ['init', '-q', '--bare']);
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  git(wt, ['init', '-q'], commit('init', '--allow-empty'),
    ['remote', 'add', 'origin', origin], ['checkout', '-qb', 'autodev/001-x']);
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  git(wt, ['add', '-A'], commit('pkg'));
  return wt;
}

test('runner drives a run through all seven stages to DONE', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree();
  const id = createRun(db, { slug: 'x', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'demo feature' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'DONE');
  const events = readFileSync(join(runDir(id), 'events.jsonl'), 'utf8');
  for (const t of ['stage_started', 'stage_done', 'run_done']) assert.match(events, new RegExp(t));
});

test('runner parks a run when a stage keeps failing, resume re-enters at that stage', () => {
  // break the stub for review: always REQUEST_CHANGES
  writeFileSync(stubPath, readFileSync(stubPath, 'utf8')
    .replace('APPROVE', 'REQUEST_CHANGES'));
  const db = openDb();
  const wt = makeRepoWithWorktree();
  const id = createRun(db, { slug: 'y', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  writeFileSync(join(stubDir, 'calls'), ''); // reset invocation counter
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.stage, 6);
  assert.ok(existsSync(join(runDir(id), 'blocked.md')));
  // internal review budget (3 rounds + 2 fixes) must not be multiplied by outer retries
  const reviewCalls = readFileSync(join(stubDir, 'calls'), 'utf8')
    .split('\n').filter(l => /code.review/.test(l));
  assert.equal(reviewCalls.length, 5, `expected 5 review-stage claude calls, got ${reviewCalls.length}`);
  // fix the stub, resume
  writeFileSync(stubPath, readFileSync(stubPath, 'utf8')
    .replace('REQUEST_CHANGES', 'APPROVE'));
  execFileSync('node', ['src/runner.js', String(id), '--resume'], { env: process.env });
  const db3 = openDb();
  assert.equal(getRun(db3, id).status, 'DONE'); db3.close();
});
