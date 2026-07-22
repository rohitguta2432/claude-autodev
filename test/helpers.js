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

// The full-pipeline stub used by runner + e2e tests: reads the -p prompt and
// fabricates the artifact each stage's check gates on. `callsFile` (optional)
// records the first 60 chars of every prompt, mirroring the old bash stub.
export const pipelineStubJs = (callsFile) => `
const fs = require('node:fs');
const cp = require('node:child_process');
const p = String(process.argv[3] ?? '');
${callsFile ? `fs.appendFileSync(${JSON.stringify(callsFile)}, p.slice(0, 60) + '\\n');` : ''}
const git = (...a) => cp.execFileSync('git', a, { stdio: 'ignore' });
const commitAll = (m) => { git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m); };
if (p.includes('specs-skill')) {
  fs.mkdirSync('specs/001-x/checklists', { recursive: true });
  const spec = '# spec\\ncontent...............................................\\n';
  fs.writeFileSync('specs/001-x/spec.md', spec);
  fs.writeFileSync('specs/001-x/plan.md', spec);
  fs.writeFileSync('specs/001-x/tasks.md', '- [ ] T001 build\\n');
  fs.writeFileSync('specs/001-x/checklists/requirements.md', '- [x] ok\\n');
  commitAll('spec');
} else if (p.includes('executing-plans')) {
  const t = 'specs/001-x/tasks.md';
  fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replaceAll('- [ ]', '- [x]'));
  commitAll('impl');
} else if (p.includes('ce-commit-push-pr')) {
  git('push', '-q', '-u', 'origin', 'HEAD');
} else if (p.includes('speckit.verify')) {
  fs.mkdirSync('.autodev', { recursive: true });
  fs.writeFileSync('.autodev/verify.json', '{"verdict":"PASS","findings":[]}');
} else if (p.includes('code-review')) {
  fs.mkdirSync('.autodev', { recursive: true });
  fs.writeFileSync('.autodev/review.json', '{"verdict":"APPROVE","findings":[]}');
}
`;
