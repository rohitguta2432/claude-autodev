import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-run-'));
const { openDb, createRun, getRun, runDir } = await import('../src/db.js');

// Stub claude: reads the -p prompt, fabricates the right artifact per stage keyword.
const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
writeFileSync(join(stubDir, 'claude'), `#!/usr/bin/env bash
prompt="$2"
echo "\${prompt:0:60}" >> ${join(stubDir, 'calls')}
case "$prompt" in
  *vista-spec*) mkdir -p specs/001-x/checklists
    printf '# spec\\ncontent...............................................\\n' > specs/001-x/spec.md
    cp specs/001-x/spec.md specs/001-x/plan.md
    printf -- '- [ ] T001 build\\n' > specs/001-x/tasks.md
    printf -- '- [x] ok\\n' > specs/001-x/checklists/requirements.md
    git add -A; git -c user.email=t@t -c user.name=t commit -qm spec ;;
  *executing-plans*) perl -i -pe 's/- \\[ \\]/- [x]/' specs/001-x/tasks.md
    git add -A; git -c user.email=t@t -c user.name=t commit -qm impl ;;
  *ce-commit-push-pr*) git push -q -u origin HEAD ;;
  *code-review*) mkdir -p .autodev
    echo '{"verdict":"APPROVE","findings":[]}' > .autodev/review.json ;;
  *) exit 0 ;;
esac`);
chmodSync(join(stubDir, 'claude'), 0o755);
process.env.AUTODEV_CLAUDE_BIN = join(stubDir, 'claude');

function makeRepoWithWorktree() {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  execSync('git init -q --bare', { cwd: origin });
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  execSync(`git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git remote add origin ${origin} && git checkout -qb autodev/001-x`, { cwd: wt, shell: '/bin/bash' });
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }));
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm pkg', { cwd: wt, shell: '/bin/bash' });
  return wt;
}

test('runner drives a run through all six stages to DONE', () => {
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
  writeFileSync(join(stubDir, 'claude'), readFileSync(join(stubDir, 'claude'), 'utf8')
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
  assert.equal(run.stage, 5);
  assert.ok(existsSync(join(runDir(id), 'blocked.md')));
  // internal review budget (3 rounds + 2 fixes) must not be multiplied by outer retries
  const reviewCalls = readFileSync(join(stubDir, 'calls'), 'utf8')
    .split('\n').filter(l => /code.review/.test(l));
  assert.equal(reviewCalls.length, 5, `expected 5 review-stage claude calls, got ${reviewCalls.length}`);
  // fix the stub, resume
  writeFileSync(join(stubDir, 'claude'), readFileSync(join(stubDir, 'claude'), 'utf8')
    .replace('REQUEST_CHANGES', 'APPROVE'));
  execFileSync('node', ['src/runner.js', String(id), '--resume'], { env: process.env });
  const db3 = openDb();
  assert.equal(getRun(db3, id).status, 'DONE'); db3.close();
});
