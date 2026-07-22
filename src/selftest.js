// `autodev selftest` — prove an install works in ~30 seconds without spending
// any Claude quota: a throwaway fixture repo is driven through all 7 stages by
// a stubbed claude that fabricates each stage's gated artifact.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The stub claude (a portable Node script — see the .js AUTODEV_CLAUDE_BIN
// convention in runner.js): keys on stage-prompt keywords, writes the artifact
// each stage's check gates on. Also used by the test suite via test/helpers.js.
export const pipelineStubJs = (callsFile) => `
const fs = require('node:fs');
const cp = require('node:child_process');
const p = String(process.argv[3] ?? '');
${callsFile ? `fs.appendFileSync(${JSON.stringify(callsFile)}, p.slice(0, 60) + '\\n');` : ''}
const git = (...a) => cp.execFileSync('git', a, { stdio: 'ignore' });
const commitAll = (m) => { git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m); };
if (p.includes('autodev-specs')) {
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

export async function selftest() {
  const tmp = mkdtempSync(join(tmpdir(), 'autodev-selftest-'));
  // fully isolated state — a selftest must never touch the real db or worktrees
  process.env.AUTODEV_HOME = join(tmp, 'home');
  process.env.AUTODEV_PORT = '0'; // no server needed; events fall back to jsonl only
  const stub = join(tmp, 'claude-stub.js');
  writeFileSync(stub, pipelineStubJs());
  process.env.AUTODEV_CLAUDE_BIN = stub;

  const git = (cwd, ...cmds) => { for (const a of cmds) execFileSync('git', a, { cwd, stdio: 'pipe' }); };
  const commit = (m) => ['-c', 'user.email=selftest@autodev', '-c', 'user.name=selftest', 'commit', '-q', '-m', m];
  const origin = join(tmp, 'origin'); const wt = join(tmp, 'repo');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', wt]);
  git(wt, commit('init').concat('--allow-empty'), ['remote', 'add', 'origin', origin], ['checkout', '-qb', 'autodev/001-selftest']);
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  git(wt, ['add', '-A'], commit('pkg'));

  const { openDb, createRun, getRun, runDir } = await import('./db.js');
  const db = openDb();
  const id = createRun(db, { slug: 'selftest', repo: 'selftest', repo_path: wt, worktree: wt,
    branch: 'autodev/001-selftest', requirement: 'selftest fixture run' });
  db.close();
  console.log('driving a fixture repo through all 7 stages with a stubbed claude…');
  execFileSync(process.execPath, [join(ROOT, 'src/runner.js'), String(id)], { env: process.env, stdio: 'pipe' });

  const db2 = openDb();
  const run = getRun(db2, id);
  db2.close();
  const events = readFileSync(join(runDir(id), 'events.jsonl'), 'utf8');
  const { STAGES } = await import('./stages.js');
  let ok = run.status === 'DONE';
  for (const s of STAGES) {
    const passed = new RegExp(`"type":"stage_done","stage":${s.n}`).test(events)
      || new RegExp(`"stage":${s.n},"type":"stage_done"`).test(events);
    console.log(`  stage ${s.n} ${s.title.padEnd(10)} ${passed ? 'OK' : 'MISSING'}`);
    ok &&= passed;
  }
  console.log(ok ? '\nselftest PASS — install works; real runs will spend Claude sessions'
    : `\nselftest FAIL — run status ${run.status} (${run.blocked_reason ?? 'see events above'})`);
  return ok;
}
