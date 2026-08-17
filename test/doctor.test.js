import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, commit, stubClaude } from './helpers.js';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-doc-'));
process.env.AUTODEV_CLAUDE_BIN = stubClaude(mkdtempSync(join(tmpdir(), 'doc-stub-')), '');
const { doctor, originOwner } = await import('../src/doctor.js');

test('doctor passes on a healthy repo and names the detected test command', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  const checks = await doctor(repo);
  assert.equal(checks.filter(c => c.severity === 'fail').length, 0);
  assert.match(checks.find(c => c.name.includes('test command')).detail, /npm test/);
});

test('doctor fails on a non-repo target and the CLI exits non-zero', async () => {
  const notRepo = mkdtempSync(join(tmpdir(), 'norepo-'));
  const checks = await doctor(notRepo);
  const fail = checks.find(c => c.name.includes('git repo'));
  assert.equal(fail.severity, 'fail');
  assert.match(fail.fix, /--repo/);
  assert.throws(() => execFileSync('node', ['bin/autodev.js', 'doctor', notRepo], { encoding: 'utf8', stdio: 'pipe' }));
});

test('doctor warns about untracked build config the worktree will not have, and worktreeCopy resolves it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));
  writeFileSync(join(repo, 'local.properties'), 'sdk.dir=x');
  writeFileSync(join(repo, '.env'), 'A=1');
  let c = (await doctor(repo)).find(x => x.name === 'build config reaches the worktree');
  assert.equal(c.severity, 'warn');
  assert.match(c.detail, /local\.properties/);
  assert.match(c.detail, /\.env/);
  writeFileSync(join(repo, '.autodev.json'), JSON.stringify({ worktreeCopy: ['local.properties', '.env'] }));
  c = (await doctor(repo)).find(x => x.name === 'build config reaches the worktree');
  assert.equal(c, undefined);
});

test('autodev run aborts before creating anything when preflight fails', () => {
  const notRepo = mkdtempSync(join(tmpdir(), 'norepo-'));
  assert.throws(() => execFileSync('node', ['bin/autodev.js', 'run', 'x y z', '--repo', notRepo, '--no-spawn'],
    { encoding: 'utf8', stdio: 'pipe' }), /preflight/s);
});

test('.autodev.json reaches the run: untracked, committed, modified, and invalid-JSON states', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));

  writeFileSync(join(repo, '.autodev.json'), JSON.stringify({ maxCostUsd: 5 }));
  let checks = await doctor(repo);
  let reach = checks.find(c => c.name === '.autodev.json reaches the run');
  assert.equal(reach.severity, 'warn');
  assert.match(reach.detail, /untracked/);

  git(repo, ['add', '-A'], commit('add config'));
  checks = await doctor(repo);
  reach = checks.find(c => c.name === '.autodev.json reaches the run');
  assert.equal(reach.severity, 'pass');

  writeFileSync(join(repo, '.autodev.json'), JSON.stringify({ maxCostUsd: 10 }));
  checks = await doctor(repo);
  reach = checks.find(c => c.name === '.autodev.json reaches the run');
  assert.match(reach.detail, /differs from HEAD/);

  writeFileSync(join(repo, '.autodev.json'), '{ not json');
  checks = await doctor(repo);
  const parses = checks.find(c => c.name === '.autodev.json parses');
  assert.equal(parses.severity, 'warn');
});

test('.autodev.json checks are absent entirely when the file does not exist', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));
  const checks = await doctor(repo);
  assert.equal(checks.find(c => c.name === '.autodev.json reaches the run'), undefined);
  assert.equal(checks.find(c => c.name === '.autodev.json parses'), undefined);
});

test('doctor warns when a detected gradle suite has no test sources, and stays silent once it does', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));
  writeFileSync(join(repo, 'build.gradle'), '');
  git(repo, ['add', '-A'], commit('gradle'));

  let checks = await doctor(repo);
  const vac = checks.find(c => c.name === 'detected test suite is non-vacuous');
  assert.equal(vac.severity, 'warn');

  mkdirSync(join(repo, 'src', 'test', 'java'), { recursive: true });
  checks = await doctor(repo);
  assert.equal(checks.find(c => c.name === 'detected test suite is non-vacuous'), undefined);
});

test('doctor warns on ambiguous test-command detection across subprojects, and an explicit testCmd silences it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));
  mkdirSync(join(repo, 'backend'));
  writeFileSync(join(repo, 'backend', 'pytest.ini'), '');
  mkdirSync(join(repo, 'frontend'));
  writeFileSync(join(repo, 'frontend', 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  git(repo, ['add', '-A'], commit('subprojects'));

  let checks = await doctor(repo);
  const amb = checks.find(c => c.name === 'test command unambiguous');
  assert.equal(amb.severity, 'warn');
  assert.match(amb.detail, /backend/);
  assert.match(amb.detail, /frontend/);

  writeFileSync(join(repo, '.autodev.json'), JSON.stringify({ testCmd: 'make check' }));
  git(repo, ['add', '-A'], commit('pin testCmd'));
  checks = await doctor(repo);
  assert.equal(checks.find(c => c.name === 'test command unambiguous'), undefined);
  assert.match(checks.find(c => c.name === 'test command detectable').detail, /testCmd in \.autodev\.json/);
});

test('originOwner parses https, git@, and ssh://git@ remote URLs; null on garbage', () => {
  assert.deepEqual(originOwner('https://github.com/foo/bar.git'), { host: 'github.com', owner: 'foo' });
  assert.deepEqual(originOwner('git@github.com:foo/bar.git'), { host: 'github.com', owner: 'foo' });
  assert.deepEqual(originOwner('ssh://git@ghe.example.com/foo/bar.git'), { host: 'ghe.example.com', owner: 'foo' });
  assert.deepEqual(originOwner('ssh://git@ghe.example.com:2222/foo/bar.git'), { host: 'ghe.example.com', owner: 'foo' });
  assert.deepEqual(originOwner('https://ghe.example.com:8443/foo/bar.git'), { host: 'ghe.example.com', owner: 'foo' });
  assert.equal(originOwner('not a url'), null);
  assert.equal(originOwner(''), null);
  assert.equal(originOwner(null), null);
});

test('doctor and run survive a malformed package.json in a sibling subdir (probes stay total)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));
  mkdirSync(join(repo, 'a-lib'));
  writeFileSync(join(repo, 'a-lib', 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  mkdirSync(join(repo, 'z-broken'));
  writeFileSync(join(repo, 'z-broken', 'package.json'), '{ // comment');
  git(repo, ['add', '-A'], commit('sibling with broken json'));

  const checks = await doctor(repo); // must resolve, not throw
  assert.equal(checks.find(c => c.name === 'test command unambiguous'), undefined, 'only one marker parses');
});

test('a gitignored .autodev.json is unreached, not clean', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));
  writeFileSync(join(repo, '.gitignore'), '.autodev.json\n');
  git(repo, ['add', '-A'], commit('gitignore'));
  writeFileSync(join(repo, '.autodev.json'), JSON.stringify({ maxCostUsd: 5 }));

  const checks = await doctor(repo);
  const reach = checks.find(c => c.name === '.autodev.json reaches the run');
  assert.equal(reach.severity, 'warn');
  assert.match(reach.detail, /untracked/);
});

test('vacuous check is not fooled by a gradle-named directory path when the detected tool is npm', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'holder-'));
  const repo = join(parent, 'gradle-tools');
  mkdirSync(repo);
  git(repo, ['init', '-q'], commit('init', '--allow-empty'));
  mkdirSync(join(repo, 'app'));
  writeFileSync(join(repo, 'app', 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  git(repo, ['add', '-A'], commit('npm subproject'));

  const checks = await doctor(repo);
  assert.equal(checks.find(c => c.name === 'detected test suite is non-vacuous'), undefined);
});
