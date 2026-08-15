import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { promptPrefix, triageClause, holdoutClause, excludeHoldout, sequesterHoldout,
         restoreHoldout, clearHoldout, hasHoldout, HOLDOUT_DIR } from '../src/guidance.js';
import { git, commit } from './helpers.js';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'guid-'));
  git(d, ['init', '-q'], commit('init', '--allow-empty'));
  return d;
}
const write = (root, rel, body) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
};

test('factory rules ride on every prompt; absent means no prefix at all', () => {
  const wt = repo();
  assert.equal(promptPrefix(wt), '');
  write(wt, '.autodev/factory-rules.md', '- one task at a time\n');
  const p = promptPrefix(wt);
  assert.match(p, /one task at a time/);
  assert.match(p, /unsupervised/);
  // whitespace-only is the same as absent — a scaffolded-but-unedited file must not
  // prepend an empty rules block to every session
  write(wt, '.autodev/factory-rules.md', '   \n\n');
  assert.equal(promptPrefix(wt), '');
});

test('triage clause appears only when the repo states a mission', () => {
  const wt = repo();
  assert.equal(triageClause(wt), '');
  write(wt, '.autodev/mission.md', '# Mission\n\n## Non-goals\n- payments\n');
  const c = triageClause(wt);
  assert.match(c, /payments/);
  assert.match(c, /"verdict":"ACCEPT"\|"REJECT"/);
});

test('holdout clause forbids implementation detail in the scenarios', () => {
  assert.match(holdoutClause(), /externally visible behaviour/);
  assert.match(holdoutClause(), new RegExp(HOLDOUT_DIR.replace('.', '\\.')));
});

test('excludeHoldout keeps scenarios out of git, so history cannot leak them', () => {
  const wt = repo();
  excludeHoldout(wt);
  write(wt, '.autodev/holdout/scenarios.md', '1. Given a user...\n');
  write(wt, 'src.txt', 'code\n');
  git(wt, ['add', '-A'], commit('work'));
  const tracked = execFileSync('git', ['ls-files'], { cwd: wt, encoding: 'utf8' });
  assert.match(tracked, /src\.txt/);
  assert.doesNotMatch(tracked, /holdout/);
});

test('sequester moves scenarios out of the worktree; restore is temporary', () => {
  const wt = repo();
  const rd = mkdtempSync(join(tmpdir(), 'rundir-'));
  assert.equal(sequesterHoldout(wt, rd), false); // nothing written → nothing to hide
  write(wt, '.autodev/holdout/scenarios.md', '1. Given a user...\n');
  assert.equal(sequesterHoldout(wt, rd), true);
  assert.equal(existsSync(join(wt, HOLDOUT_DIR)), false, 'builder must not see the directory');
  assert.equal(hasHoldout(rd), true);
  assert.match(readFileSync(join(rd, 'holdout', 'scenarios.md'), 'utf8'), /Given a user/);

  assert.equal(restoreHoldout(wt, rd), true);
  assert.equal(existsSync(join(wt, HOLDOUT_DIR, 'scenarios.md')), true);
  clearHoldout(wt);
  assert.equal(existsSync(join(wt, HOLDOUT_DIR)), false);
  assert.equal(hasHoldout(rd), true, 'the run directory keeps the only copy');
});
