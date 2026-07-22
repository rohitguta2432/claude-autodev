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

function makeRepoWithWorktree({ testMarker = true } = {}) {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  git(origin, ['init', '-q', '--bare']);
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  git(wt, ['init', '-q'], commit('init', '--allow-empty'),
    ['remote', 'add', 'origin', origin], ['checkout', '-qb', 'autodev/001-x']);
  if (testMarker) {
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
    git(wt, ['add', '-A'], commit('pkg'));
  }
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

test('runner PARKS when no test command is detectable — never a vacuous pass', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree({ testMarker: false });
  const id = createRun(db, { slug: 'z', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.stage, 7);
  assert.match(run.blocked_reason, /no test command/);
});

test('.autodev.json testCmd overrides detection and unblocks the same repo', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree({ testMarker: false });
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ testCmd: 'node -e ""' }));
  git(wt, ['add', '-A'], commit('cfg'));
  const id = createRun(db, { slug: 'w', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  assert.equal(getRun(db2, id).status, 'DONE'); db2.close();
});

test('runner parks before starting a session beyond maxCostUsd; cost CLI sums metrics', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree();
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ maxCostUsd: 1 }));
  git(wt, ['add', '-A'], commit('cfg'));
  // stub emits a claude result JSON costing $2 and produces no artifacts —
  // session 1 records the cost, session 2 must be refused by the budget gate.
  const costStub = mkdtempSync(join(tmpdir(), 'cost-stub-'));
  const stub = stubClaude(costStub,
    `process.stdout.write(JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 2, usage: { input_tokens: 10, output_tokens: 5 } }));`);
  const id = createRun(db, { slug: 'c', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: { ...process.env, AUTODEV_CLAUDE_BIN: stub } });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'BLOCKED');
  assert.match(run.blocked_reason, /cost budget exceeded/);
  const out = execFileSync('node', ['bin/autodev.js', 'cost', String(id)], { encoding: 'utf8' });
  assert.match(out, /stage 1 Spec/);
  assert.match(out, /\$2\.00/);
});

test('--until: runner stops cleanly after the named stage, DONE not BLOCKED', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree();
  const id = createRun(db, { slug: 'u', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo', until_stage: 2 });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'DONE');
  assert.equal(run.stage, 2); // never advanced past Analyze
  const events = readFileSync(join(runDir(id), 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /"stage":5,"detail":"Push"/); // push never started
  assert.match(events, /stopped after stage 2/);
});

test('.autodev.json "push": false caps the run at Verify', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree();
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ push: false }));
  git(wt, ['add', '-A'], commit('cfg'));
  const id = createRun(db, { slug: 'np', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'DONE');
  assert.equal(run.stage, 4); // Verify is the last stage that ran
});
