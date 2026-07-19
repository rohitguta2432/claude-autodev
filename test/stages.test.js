import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { STAGES, findSpecDir, detectTestCmd } from '../src/stages.js';

function gitRepo() {
  const d = mkdtempSync(join(tmpdir(), 'wt-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: d, shell: '/bin/bash' });
  return d;
}

test('stage table shape', () => {
  assert.deepEqual(STAGES.map(s => s.key), ['spec', 'analyze', 'implement', 'push', 'review', 'test']);
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
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm done', { cwd: wt, shell: '/bin/bash' });
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

test('review check reads .autodev/review.json verdict', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, '.autodev'), { recursive: true });
  assert.throws(() => STAGES[4].check({ worktree: wt }), /review/i);
  writeFileSync(join(wt, '.autodev/review.json'), JSON.stringify({ verdict: 'REQUEST_CHANGES', findings: [{ t: 'x' }] }));
  assert.throws(() => STAGES[4].check({ worktree: wt }), /REQUEST_CHANGES/);
  writeFileSync(join(wt, '.autodev/review.json'), JSON.stringify({ verdict: 'APPROVE', findings: [] }));
  STAGES[4].check({ worktree: wt }); // no throw
});
