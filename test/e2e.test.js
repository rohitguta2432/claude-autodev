import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-e2e-'));
process.env.AUTODEV_WORKTREES = mkdtempSync(join(tmpdir(), 'wts-'));
const { startServer } = await import('../src/server.js');
const { port, close } = await startServer({ port: 0 });
process.env.AUTODEV_PORT = String(port);
after(() => close());

const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
writeFileSync(join(stubDir, 'claude'), `#!/usr/bin/env bash
prompt="$2"
case "$prompt" in
  *vista-spec*) mkdir -p specs/001-x
    printf '# spec\\ncontent...............................................\\n' > specs/001-x/spec.md
    cp specs/001-x/spec.md specs/001-x/plan.md
    printf -- '- [ ] T001 build\\n' > specs/001-x/tasks.md
    git add -A; git -c user.email=t@t -c user.name=t commit -qm spec ;;
  *executing-plans*) sed -i 's/- \\[ \\]/- [x]/' specs/001-x/tasks.md
    git add -A; git -c user.email=t@t -c user.name=t commit -qm impl ;;
  *ce-commit-push-pr*) git push -q -u origin HEAD ;;
  *code-review*) mkdir -p .autodev; echo '{"verdict":"APPROVE","findings":[]}' > .autodev/review.json ;;
  *) exit 0 ;;
esac`);
chmodSync(join(stubDir, 'claude'), 0o755);
process.env.AUTODEV_CLAUDE_BIN = join(stubDir, 'claude');

test('CLI kickoff → runner → DONE, events visible via API', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  execSync('git init -q --bare', { cwd: origin });
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  execSync(`git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git remote add origin ${origin}`, { cwd: repo, shell: '/bin/bash' });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }));
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm pkg', { cwd: repo, shell: '/bin/bash' });

  execFileSync('node', ['bin/autodev.js', 'run', 'demo feature', '--repo', repo], { env: process.env });
  let run;
  for (let i = 0; i < 100; i++) { // ≤10s
    run = await (await fetch(`http://127.0.0.1:${port}/api/runs/1`)).json();
    if (run.status === 'DONE' || run.status === 'BLOCKED') break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(run.status, 'DONE');
  const types = run.events.map(e => e.type);
  assert.ok(types.includes('stage_started') && types.includes('run_done'));
});
