import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGES, findSpecDir, detectTestCmd, specDirFor, isCompleteSpecDir } from '../src/stages.js';
import { git, commit } from './helpers.js';

function gitRepo() {
  const d = mkdtempSync(join(tmpdir(), 'wt-'));
  git(d, ['init', '-q'], commit('init', '--allow-empty'));
  return d;
}

test('stage table shape', () => {
  assert.deepEqual(STAGES.map(s => s.key), ['spec', 'analyze', 'implement', 'verify', 'push', 'review', 'test']);
  for (const s of STAGES) assert.ok(s.n >= 1 && s.title && typeof s.check === 'function');
});

test('findSpecDir picks newest specs/NNN-*', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, 'specs/001-old'), { recursive: true });
  mkdirSync(join(wt, 'specs/002-new'), { recursive: true });
  assert.match(findSpecDir(wt), /002-new$/);
});

test('spec check requires non-empty spec/plan/tasks', () => {
  const wt = gitRepo();
  const run = { worktree: wt };
  assert.throws(() => STAGES[0].check(run), /spec/i);
  const d = join(wt, 'specs/001-x');
  mkdirSync(d, { recursive: true });
  for (const f of ['spec.md', 'plan.md', 'tasks.md']) writeFileSync(join(d, f), '# content\n');
  STAGES[0].check(run); // no throw
});

test('implement check requires all tasks ticked and clean tree', () => {
  const wt = gitRepo();
  const d = join(wt, 'specs/001-x');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'tasks.md'), '- [x] T001 done\n- [ ] T002 pending\n');
  assert.throws(() => STAGES[2].check({ worktree: wt }), /T002|unchecked/i);
  writeFileSync(join(d, 'tasks.md'), '- [x] T001 done\n- [X] T002 done\n');
  assert.throws(() => STAGES[2].check({ worktree: wt }), /uncommitted/i); // tasks.md change not committed
  git(wt, ['add', '-A'], commit('done'));
  STAGES[2].check({ worktree: wt }); // no throw
});

test('detectTestCmd finds npm script / pytest / mvn / none', () => {
  const a = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(a, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  assert.equal(detectTestCmd(a), 'npm test --silent');
  const b = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(b, 'pytest.ini'), '');
  assert.equal(detectTestCmd(b), 'pytest -q');
  const c = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(c, 'pom.xml'), '<project/>');
  assert.equal(detectTestCmd(c), 'mvn -q test');
  assert.equal(detectTestCmd(mkdtempSync(join(tmpdir(), 'p-'))), null);
});

test('detectTestCmd finds gradle at root and markers one level down', () => {
  const g = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(g, 'build.gradle'), '');
  assert.equal(detectTestCmd(g), 'gradle test');
  writeFileSync(join(g, 'gradlew'), '');
  assert.match(detectTestCmd(g), /gradlew(\.bat)? test$/);
  // marker only in a subdir → command cd's into it
  const m = mkdtempSync(join(tmpdir(), 'p-'));
  mkdirSync(join(m, 'backend'));
  writeFileSync(join(m, 'backend', 'pytest.ini'), '');
  assert.equal(detectTestCmd(m), `cd ${JSON.stringify(join(m, 'backend'))} && pytest -q`);
  // dotdirs and node_modules are never scanned
  const n = mkdtempSync(join(tmpdir(), 'p-'));
  mkdirSync(join(n, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(n, 'node_modules', 'x', 'pytest.ini'), '');
  assert.equal(detectTestCmd(n), null);
});

test('detectTestCmd finds tox / requirements+tests / Makefile test target / csproj', () => {
  const t = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(t, 'tox.ini'), '[tox]');
  assert.equal(detectTestCmd(t), 'tox -q');
  const r = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(r, 'requirements.txt'), 'pytest');
  assert.equal(detectTestCmd(r), null); // requirements alone is not enough
  mkdirSync(join(r, 'tests'));
  assert.equal(detectTestCmd(r), 'python -m pytest -q');
  const m = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(m, 'Makefile'), 'build:\n\techo hi\ntest:\n\techo t\n');
  assert.equal(detectTestCmd(m), 'make test');
  const m2 = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(m2, 'Makefile'), 'build:\n\techo hi\n'); // no test target
  assert.equal(detectTestCmd(m2), null);
  const c = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(c, 'App.csproj'), '<Project/>');
  assert.equal(detectTestCmd(c), 'dotnet test');
});

function completeSpec(wt, dirName) {
  const d = join(wt, 'specs', dirName);
  mkdirSync(d, { recursive: true });
  for (const f of ['spec.md', 'plan.md', 'tasks.md']) writeFileSync(join(d, f), '# content\n');
  return d;
}

test('specDirFor: single matching complete dir wins', () => {
  const wt = gitRepo();
  const d = completeSpec(wt, '001-rate-limit-api');
  assert.equal(specDirFor(wt, 'add rate limit to api'), d);
});

test('specDirFor: no matching dir returns null', () => {
  const wt = gitRepo();
  completeSpec(wt, '001-rate-limit-api');
  assert.equal(specDirFor(wt, 'build a totally unrelated dashboard widget'), null);
});

test('specDirFor: two matching dirs is ambiguous, returns null', () => {
  const wt = gitRepo();
  completeSpec(wt, '001-rate-limit-api');
  completeSpec(wt, '002-rate-limit-web');
  assert.equal(specDirFor(wt, 'add rate limit everywhere'), null);
});

test('specDirFor: matching dir with incomplete tasks.md is ignored', () => {
  const wt = gitRepo();
  const d = join(wt, 'specs', '001-rate-limit-api');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'spec.md'), '# content\n');
  writeFileSync(join(d, 'plan.md'), '# content\n');
  writeFileSync(join(d, 'tasks.md'), ''); // empty -> incomplete
  assert.equal(specDirFor(wt, 'add rate limit to api'), null);
});

test('isCompleteSpecDir: true only when spec/plan/tasks all non-empty', () => {
  const wt = gitRepo();
  const d = completeSpec(wt, '001-x');
  assert.equal(isCompleteSpecDir(d), true);
  assert.equal(isCompleteSpecDir(join(wt, 'specs', 'nope')), false);
});

test('review check reads .autodev/review.json verdict', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, '.autodev'), { recursive: true });
  assert.throws(() => STAGES[5].check({ worktree: wt }), /review/i);
  writeFileSync(join(wt, '.autodev/review.json'), JSON.stringify({ verdict: 'REQUEST_CHANGES', findings: [{ t: 'x' }] }));
  assert.throws(() => STAGES[5].check({ worktree: wt }), /REQUEST_CHANGES/);
  writeFileSync(join(wt, '.autodev/review.json'), JSON.stringify({ verdict: 'APPROVE', findings: [] }));
  STAGES[5].check({ worktree: wt }); // no throw
});

test('verify check gates on .autodev/verify.json verdict and severity', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, '.autodev'), { recursive: true });
  assert.throws(() => STAGES[3].check({ worktree: wt }), /verify/i);
  writeFileSync(join(wt, '.autodev/verify.json'), JSON.stringify({ verdict: 'FAIL', findings: [{ severity: 'CRITICAL' }] }));
  assert.throws(() => STAGES[3].check({ worktree: wt }), /FAIL/);
  writeFileSync(join(wt, '.autodev/verify.json'), JSON.stringify({ verdict: 'PASS', findings: [{ severity: 'HIGH' }] }));
  assert.throws(() => STAGES[3].check({ worktree: wt }), /critical\/high/i); // PASS with HIGH finding still blocks
  writeFileSync(join(wt, '.autodev/verify.json'), JSON.stringify({ verdict: 'PASS', findings: [{ severity: 'MEDIUM' }] }));
  STAGES[3].check({ worktree: wt }); // no throw — MEDIUM/LOW don't gate
});

test('push stage opens the PR as a DRAFT — review/test have not run at stage 5', () => {
  const run = { branch: 'b', requirement: 'q', jira_key: null, issue_type: null };
  assert.match(STAGES[4].prompt(run), /--draft/);
  assert.match(STAGES[4].prompt(run), /DRAFT pull request/);
});
