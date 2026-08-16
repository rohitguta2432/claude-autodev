import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { STAGES, scheduledStages, findSpecDir, specDirOf, detectTestCmd, specDirFor, isCompleteSpecDir } from '../src/stages.js';
import { git, commit } from './helpers.js';

function gitRepo() {
  const d = mkdtempSync(join(tmpdir(), 'wt-'));
  git(d, ['init', '-q'], commit('init', '--allow-empty'));
  return d;
}

test('stage table shape', () => {
  assert.deepEqual(STAGES.map(s => s.key), ['spec', 'analyze', 'implement', 'verify', 'push', 'review', 'test', 'deploy']);
  for (const s of STAGES) assert.ok(s.n >= 1 && s.title && typeof s.check === 'function');
});

test('deploy is scheduled only when the repo configures it', () => {
  assert.deepEqual(scheduledStages({}).map(s => s.key).at(-1), 'test');
  assert.equal(scheduledStages({}).length, 7);
  assert.equal(scheduledStages({ deploy: { cmd: './ship.sh' } }).length, 8);
  assert.deepEqual(scheduledStages({ deploy: { merge: true } }).at(-1).key, 'deploy');
});

test('findSpecDir picks newest specs/NNN-*', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, 'specs/001-old'), { recursive: true });
  mkdirSync(join(wt, 'specs/002-new'), { recursive: true });
  assert.match(findSpecDir(wt), /002-new$/);
});

test('specDirOf prefers the run\'s pinned directory over the highest-numbered one', () => {
  const wt = gitRepo();
  for (const n of ['001-chosen', '002-other', '015-newest']) mkdirSync(join(wt, 'specs', n), { recursive: true });
  assert.match(specDirOf({ worktree: wt, spec_dir: 'specs/001-chosen' }), /001-chosen$/);
  assert.match(specDirOf({ worktree: wt }), /015-newest$/, 'unpinned keeps the old behaviour');
});

test('specDirOf falls back rather than failing when the pin is not in this worktree', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, 'specs/003-present'), { recursive: true });
  // deleted, renamed, or recorded against a different worktree — never a reason to park
  assert.match(specDirOf({ worktree: wt, spec_dir: 'specs/099-vanished' }), /003-present$/);
  // …and a pin pointing at a file rather than a directory is equally not a directory
  writeFileSync(join(wt, 'specs/notadir'), 'x');
  assert.match(specDirOf({ worktree: wt, spec_dir: 'specs/notadir' }), /003-present$/);
  assert.equal(specDirOf({ worktree: gitRepo(), spec_dir: 'specs/099-vanished' }), null);
});

test('stage checks and prompts both follow the pin — they cannot disagree', () => {
  const wt = gitRepo();
  const body = '# doc\ncontent......................\n';
  for (const n of ['001-chosen', '015-newest']) {
    mkdirSync(join(wt, 'specs', n, 'checklists'), { recursive: true });
    for (const f of ['spec.md', 'plan.md']) writeFileSync(join(wt, 'specs', n, f), body);
  }
  // Only the PINNED spec has an unchecked task; the newest is complete.
  writeFileSync(join(wt, 'specs/001-chosen/tasks.md'), '- [ ] T001 unfinished\n');
  writeFileSync(join(wt, 'specs/015-newest/tasks.md'), '- [x] T001 done\n');
  const run = { worktree: wt, spec_dir: 'specs/001-chosen' };

  const implement = STAGES.find(s => s.key === 'implement');
  assert.throws(() => implement.check(run), /T001/, 'the check must read the pinned tasks.md');
  for (const key of ['analyze', 'implement', 'verify']) {
    const p = STAGES.find(s => s.key === key).prompt(run);
    assert.match(p, /specs\/001-chosen/, `stage ${key} prompt must name the pinned spec`);
    assert.doesNotMatch(p, /the newest specs/, `stage ${key} prompt must not say "newest" when pinned`);
  }
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
  assert.equal(detectTestCmd(g), process.platform === 'win32' ? '.\\gradlew.bat test' : './gradlew test');
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

test('win32: the detected gradlew command survives NoDefaultCurrentDirectoryInExePath=1', { skip: process.platform !== 'win32' }, () => {
  const g = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(g, 'build.gradle'), '');
  writeFileSync(join(g, 'gradlew'), '');
  writeFileSync(join(g, 'gradlew.bat'), '@echo gradle-ok\r\n');
  const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' };
  // the bare form is exactly what that env var breaks...
  assert.throws(() => execSync('gradlew.bat test', { cwd: g, env, stdio: 'pipe' }), /is not recognized/);
  // ...and the detected form must keep working
  assert.match(execSync(detectTestCmd(g), { cwd: g, env, encoding: 'utf8' }), /gradle-ok/);
  // the composed subdir form (cd "<sub>" && .\gradlew.bat test) must survive it too
  const s = mkdtempSync(join(tmpdir(), 'p-'));
  mkdirSync(join(s, 'app'));
  writeFileSync(join(s, 'app', 'build.gradle'), '');
  writeFileSync(join(s, 'app', 'gradlew'), '');
  writeFileSync(join(s, 'app', 'gradlew.bat'), '@echo gradle-ok\r\n');
  assert.match(execSync(detectTestCmd(s), { cwd: s, env, encoding: 'utf8' }), /gradle-ok/);
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
