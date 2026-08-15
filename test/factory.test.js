// The four behaviours that make this a factory rather than a PR generator: a mission it can
// refuse work against, acceptance criteria the builder cannot read, and a deploy at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, commit, stubClaude, pipelineStubJs } from './helpers.js';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-factory-'));
process.env.AUTODEV_PORT = '0';
const { openDb, createRun, getRun, runDir } = await import('../src/db.js');

function makeRepo(files = {}) {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  git(origin, ['init', '-q', '--bare']);
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  git(wt, ['init', '-q'], commit('init', '--allow-empty'),
    ['remote', 'add', 'origin', origin], ['checkout', '-qb', 'autodev/001-x']);
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(wt, rel, '..'), { recursive: true });
    writeFileSync(join(wt, rel), body);
  }
  git(wt, ['add', '-A'], commit('fixture'));
  return wt;
}

function drive(wt, stubJs, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  const env = { ...process.env, AUTODEV_CLAUDE_BIN: stubClaude(dir, stubJs) };
  const db = openDb();
  const id = createRun(db, { slug: 'x', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo feature', ...extra });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  return { id, run, events: readFileSync(join(runDir(id), 'events.jsonl'), 'utf8') };
}

// A whole-pipeline stub whose spec stage is written per test. Spelled out rather than
// patched into the shared one: these tests turn on exactly what the spec session does.
const stubJs = ({ spec, holdout = null, extra = '' }) => `
const fs = require('node:fs');
const cp = require('node:child_process');
const p = String(process.argv[3] ?? '');
const git = (...a) => cp.execFileSync('git', a, { stdio: 'ignore' });
const commitAll = (m) => { git('add', '-A'); git('-c','user.email=t@t','-c','user.name=t','commit','-qm', m); };
const writeSpec = () => {
  fs.mkdirSync('specs/001-x/checklists', { recursive: true });
  const spec = '# spec\\ncontent...............................................\\n';
  fs.writeFileSync('specs/001-x/spec.md', spec);
  fs.writeFileSync('specs/001-x/plan.md', spec);
  fs.writeFileSync('specs/001-x/tasks.md', '- [ ] T001 build\\n');
  fs.writeFileSync('specs/001-x/checklists/requirements.md', '- [x] ok\\n');
};
const writeJson = (f, o) => { fs.mkdirSync('.autodev', { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
if (p.includes('autodev-specs')) {
  ${spec}
  commitAll('spec');
} else if (p.includes('executing-plans')) {
  ${extra}
  const t = 'specs/001-x/tasks.md';
  fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replaceAll('- [ ]', '- [x]'));
  commitAll('impl');
} else if (p.includes('independent acceptance check')) {
  ${holdout ? `writeJson('.autodev/holdout.json', ${JSON.stringify(holdout)});` : ''}
} else if (p.includes('Acceptance scenarios you cannot see')) {
  fs.writeFileSync('fix-prompt.txt', p);
} else if (p.includes('ce-commit-push-pr')) {
  git('push', '-q', '-u', 'origin', 'HEAD');
} else if (p.includes('speckit.verify')) {
  writeJson('.autodev/verify.json', { verdict: 'PASS', findings: [] });
} else if (p.includes('code-review')) {
  writeJson('.autodev/review.json', { verdict: 'APPROVE', findings: [] });
}
`;

// The spec stage writes scenarios the builder is never allowed to see.
const SPEC_WITH_HOLDOUT = `writeSpec();
  fs.mkdirSync('.autodev/holdout', { recursive: true });
  fs.writeFileSync('.autodev/holdout/scenarios.md', '1. Given the app, When started, Then it responds.\\n');`;

test('a requirement the mission calls out of scope is REJECTED, not built', () => {
  const wt = makeRepo({ '.autodev/mission.md': '# Mission\n\n## Non-goals\n- payments\n' });
  const { run, events } = drive(wt, stubJs({
    spec: `writeJson('.autodev/triage.json', { verdict: 'REJECT', reason: 'payments are a non-goal' });`,
  }));
  assert.equal(run.status, 'REJECTED');
  assert.equal(run.stage, 1);
  assert.match(run.blocked_reason, /payments are a non-goal/);
  assert.match(events, /"type":"rejected"/);
  // rejection stops before any code exists — no spec, no branch work, no PR
  assert.equal(existsSync(join(wt, 'specs')), false);
  assert.doesNotMatch(events, /"type":"stage_started","stage":3/);
});

test('an ACCEPT verdict lets the same run proceed normally', () => {
  const wt = makeRepo({ '.autodev/mission.md': '# Mission\n\n## Goals\n- anything\n' });
  const { run } = drive(wt, stubJs({
    spec: `writeJson('.autodev/triage.json', { verdict: 'ACCEPT', reason: 'in scope' }); writeSpec();`,
  }));
  assert.equal(run.status, 'DONE');
});

test('holdout scenarios are hidden from the builder and gate the run', () => {
  const wt = makeRepo();
  const { id, run, events } = drive(wt, stubJs({
    spec: SPEC_WITH_HOLDOUT,
    holdout: { verdict: 'PASS', findings: [] },
    extra: `fs.writeFileSync('builder-saw-holdout.txt', String(fs.existsSync('.autodev/holdout/scenarios.md')));`,
  }));
  assert.equal(run.status, 'DONE');
  assert.equal(readFileSync(join(wt, 'builder-saw-holdout.txt'), 'utf8'), 'false',
    'the builder must not be able to read the acceptance criteria it is judged by');
  assert.equal(existsSync(join(runDir(id), 'holdout', 'scenarios.md')), true);
  assert.match(events, /sequestered/);
  assert.match(events, /holdout scenarios PASS/);
  // and never committed — history is the other way the builder could have read them
  assert.doesNotMatch(execFileSync('git', ['ls-files'], { cwd: wt, encoding: 'utf8' }), /\.autodev\/holdout/);
});

test('failing holdout scenarios park the run even with a green test suite', () => {
  const wt = makeRepo();
  const { run } = drive(wt, stubJs({
    spec: SPEC_WITH_HOLDOUT,
    holdout: { verdict: 'FAIL', findings: [{ scenario: '1', observed: 'no response', severity: 'HIGH' }] },
  }));
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.stage, 7);
  assert.match(run.blocked_reason, /holdout/);
  // the fix session is told what was observed, never the scenarios themselves
  const fix = readFileSync(join(wt, 'fix-prompt.txt'), 'utf8');
  assert.match(fix, /no response/);
  assert.doesNotMatch(fix, /When started, Then it responds/);
});

test('deploy runs only when configured, and its command decides the run', () => {
  // merge:false keeps gh out of the test — merging is exercised by its own error path
  const deployJs = `require('node:fs').writeFileSync('deployed.txt', 'ok');`;
  const wt = makeRepo({
    '.autodev.json': JSON.stringify({ deploy: { merge: false, cmd: 'node deploy.js' } }),
    'deploy.js': deployJs,
  });
  const { run, events } = drive(wt, pipelineStubJs());
  assert.equal(run.status, 'DONE');
  assert.equal(readFileSync(join(wt, 'deployed.txt'), 'utf8'), 'ok');
  assert.match(events, /"type":"stage_done","stage":8|"stage":8,"type":"stage_done"/);
});

test('a failing deploy parks the run instead of handing an agent the production fix', () => {
  const wt = makeRepo({
    '.autodev.json': JSON.stringify({ deploy: { merge: false, cmd: 'node deploy.js' } }),
    'deploy.js': `console.error('release blocked by change freeze'); process.exit(3);`,
  });
  const { id, run } = drive(wt, pipelineStubJs());
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.stage, 8);
  assert.match(run.blocked_reason, /deploy command failed/);
  assert.match(readFileSync(join(runDir(id), 'deploy-output.txt'), 'utf8'), /change freeze/);
});

test('an unconfigured repo has no deploy stage and still finishes', () => {
  const wt = makeRepo();
  const { run, events } = drive(wt, pipelineStubJs());
  assert.equal(run.status, 'DONE');
  assert.doesNotMatch(events, /"type":"stage_started","stage":8/);
});
