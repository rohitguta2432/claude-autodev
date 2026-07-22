import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, commit, stubClaude } from './helpers.js';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-doc-'));
process.env.AUTODEV_CLAUDE_BIN = stubClaude(mkdtempSync(join(tmpdir(), 'doc-stub-')), '');
const { doctor } = await import('../src/doctor.js');

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

test('autodev run aborts before creating anything when preflight fails', () => {
  const notRepo = mkdtempSync(join(tmpdir(), 'norepo-'));
  assert.throws(() => execFileSync('node', ['bin/autodev.js', 'run', 'x y z', '--repo', notRepo, '--no-spawn'],
    { encoding: 'utf8', stdio: 'pipe' }), /preflight/s);
});
