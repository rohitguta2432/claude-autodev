import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, commit, stubClaude, pipelineStubJs } from './helpers.js';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-e2e-'));
process.env.AUTODEV_WORKTREES = mkdtempSync(join(tmpdir(), 'wts-'));
const { startServer } = await import('../src/server.js');
const { port, close } = await startServer({ port: 0 });
process.env.AUTODEV_PORT = String(port);
after(() => close());

const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
process.env.AUTODEV_CLAUDE_BIN = stubClaude(stubDir, pipelineStubJs());

test('CLI kickoff → runner → DONE, events visible via API', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  git(origin, ['init', '-q', '--bare']);
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'),
    ['remote', 'add', 'origin', origin]);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  git(repo, ['add', '-A'], commit('pkg'));

  execFileSync('node', ['bin/autodev.js', 'run', 'demo feature', '--repo', repo], { env: process.env });
  let run;
  // ≤60s. Seven stubbed stages each spawn node and touch the disk; 10s was enough on
  // CI runners but not on a real workstation (antivirus on spawn, slower I/O), so the
  // suite went red on contributors' machines while CI stayed green. The loop exits as
  // soon as the run settles, so a fast machine pays nothing for the larger ceiling.
  for (let i = 0; i < 600; i++) {
    run = await (await fetch(`http://127.0.0.1:${port}/api/runs/1`)).json();
    if (run.status === 'DONE' || run.status === 'BLOCKED') break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(run.status, 'DONE',
    `run settled as ${run.status}${run.blocked_reason ? ` — ${run.blocked_reason}` : ''} (stage ${run.stage})`);
  const types = run.events.map(e => e.type);
  assert.ok(types.includes('stage_started') && types.includes('run_done'));
});
