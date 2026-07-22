// Shared portable test fixtures — no shell, no bash, works on win32/macOS/Linux.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Run git commands sequentially without a shell: git(cwd, ['init','-q'], ['add','-A'], …)
export function git(cwd, ...cmds) {
  for (const args of cmds) execFileSync('git', args, { cwd, stdio: 'pipe' });
}
// The `-c user… commit` boilerplate every fixture needs.
export const commit = (msg, ...extra) =>
  ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', ...extra, '-m', msg];

// Write a claude stub as a NODE script (CommonJS — temp dirs have no package.json).
// Product code invokes AUTODEV_CLAUDE_BIN via process.execPath when it ends in .js,
// which is portable everywhere and removes the shell entirely.
export function stubClaude(dir, jsBody) {
  const p = join(dir, 'claude-stub.js');
  writeFileSync(p, jsBody);
  return p;
}

// The full-pipeline claude stub lives in src/selftest.js (it powers
// `autodev selftest` too) — re-exported here for the test suite.
export { pipelineStubJs } from '../src/selftest.js';
