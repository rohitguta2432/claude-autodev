// Shared portable test fixtures — no shell, no bash, works on win32/macOS/Linux.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
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

// A claude stub that always FAILS, with output and exit status the test chooses.
// `recordTo` gets one JSON line per invocation, so a test can assert how many sessions were
// actually spent (the assertion that matters for terminal classification) and what prompt each
// one received (the assertion that matters for resume seeding).
export const failingStubJs = ({ stdout = '', stderr = '', exit = 1, recordTo = null } = {}) => `
const fs = require('node:fs');
// The runner's auth preflight (\`claude auth status\`) is not a session: answer like a CLI
// without the subcommand so it is neither recorded nor counted against the retry budget.
if (process.argv[2] === 'auth') process.exit(1);
const p = String(process.argv[3] ?? '');
${recordTo ? `fs.appendFileSync(${JSON.stringify(recordTo)}, JSON.stringify({ prompt: p }) + '\\n');` : ''}
${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ''}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}
process.exit(${exit});
`;

// One invocation record per line, as written by failingStubJs.
export function sessionsFrom(recordFile) {
  try {
    return readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

// A git repo holding several COMPLETE specs/NNN-* directories — the fixture that exposes
// "highest-numbered directory wins" resolution.
export function repoWithSpecs(dir, names) {
  git(dir, ['init', '-q', '-b', 'main']);
  for (const name of names) {
    const d = join(dir, 'specs', name);
    mkdirSync(join(d, 'checklists'), { recursive: true });
    writeFileSync(join(d, 'spec.md'), `# spec for ${name}\ncontent............................\n`);
    writeFileSync(join(d, 'plan.md'), `# plan for ${name}\ncontent............................\n`);
    writeFileSync(join(d, 'tasks.md'), `- [ ] T001 do the ${name} work\n`);
    writeFileSync(join(d, 'checklists', 'requirements.md'), '- [x] ok\n');
  }
  git(dir, ['add', '-A'], commit('specs'));
  return dir;
}
