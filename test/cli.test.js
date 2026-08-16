import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, openSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, delimiter } from 'node:path';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { git, commit, stubClaude } from './helpers.js';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-cli-'));
process.env.AUTODEV_PORT = '0'; // test provides its own server port below
process.env.AUTODEV_WORKTREES = mkdtempSync(join(tmpdir(), 'wts-'));

const { startServer } = await import('../src/server.js');
const { openDb, getRun, createRun, listRuns, updateRun, runDir } = await import('../src/db.js');
const { port, close } = await startServer({ port: 0 });
process.env.AUTODEV_PORT = String(port);

// stub claude that instantly succeeds nothing (runner will park; we only test kickoff mechanics)
const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
process.env.AUTODEV_CLAUDE_BIN = stubClaude(stubDir, '');

test('autodev run creates worktree, branch, registers run, spawns runner', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'add a health endpoint', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.match(out, /run #1/i);
  const db = openDb();
  const run = getRun(db, 1); db.close();
  assert.equal(run.status, 'RUNNING');
  assert.match(run.branch, /^autodev\/001-/);
  assert.match(readFileSync(join(run.worktree, '.git'), 'utf8'), /gitdir/); // it's a worktree
  const branches = execSync('git branch --list', { cwd: run.worktree, encoding: 'utf8' });
  assert.match(branches, /autodev\/001-/);
  close();
});

function repoWithCompleteSpec() {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main']);
  mkdirSync(join(repo, 'specs/001-rate-limit'), { recursive: true });
  writeFileSync(join(repo, 'specs/001-rate-limit/spec.md'), '# spec\n');
  writeFileSync(join(repo, 'specs/001-rate-limit/plan.md'), '# plan\n');
  writeFileSync(join(repo, 'specs/001-rate-limit/tasks.md'), '- [ ] T001 x\n');
  git(repo, ['add', '-A'], commit('init'));
  return repo;
}

test('autodev run auto-adopts a matching complete spec and starts at stage 2', () => {
  const repo = repoWithCompleteSpec();
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'add rate limit to api', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.match(out, /adopting existing spec: specs\/001-rate-limit \(starting at Analyze\)/);
  const db = openDb();
  const run = listRuns(db)[0];
  db.close();
  assert.equal(run.stage, 2);
  // Persisted, not merely printed: every stage resolves the spec through this column, and
  // without it each one re-picks the highest-numbered directory instead.
  assert.equal(run.spec_dir, 'specs/001-rate-limit');
});

test('autodev run --spec persists the chosen directory, repo-relative and POSIX-form', () => {
  const repo = repoWithCompleteSpec();
  execFileSync('node', ['bin/autodev.js', 'run', 'unrelated words entirely', '--repo', repo,
    '--no-spawn', '--spec', 'specs/001-rate-limit'], { encoding: 'utf8' });
  const db = openDb();
  const run = listRuns(db)[0]; db.close();
  assert.equal(run.spec_dir, 'specs/001-rate-limit');
  assert.doesNotMatch(run.spec_dir, /\\/, 'stored POSIX-form even on win32 — it is a repo path');
  assert.ok(!run.spec_dir.startsWith('/') && !/^[A-Za-z]:/.test(run.spec_dir), 'never absolute');
});

test('a run that adopts nothing leaves spec_dir null until its stage 1 creates one', () => {
  const repo = repoWithCompleteSpec();
  execFileSync('node', ['bin/autodev.js', 'run', 'build an unrelated dashboard widget', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  const db = openDb();
  const run = listRuns(db)[0]; db.close();
  assert.equal(run.spec_dir, null);
  assert.equal(run.stage, 1);
});

test('autodev run leaves stage 1 and prints nothing extra when requirement does not match any spec', () => {
  const repo = repoWithCompleteSpec();
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'build an unrelated dashboard widget', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.doesNotMatch(out, /adopting existing spec/);
  const db = openDb();
  const run = listRuns(db)[0];
  db.close();
  assert.equal(run.stage, 1);
});

test('autodev run --spec <path> pointing at incomplete dir fails cleanly: exit non-zero, no run row, no worktree', () => {
  const repo = repoWithCompleteSpec();
  writeFileSync(join(repo, 'specs/001-rate-limit/tasks.md'), ''); // make it incomplete
  git(repo, ['add', '-A'], commit('incomplete'));
  const db = openDb();
  const before = listRuns(db).length;
  db.close();
  assert.throws(() => execFileSync('node', ['bin/autodev.js', 'run', 'add rate limit', '--repo', repo, '--spec', 'specs/001-rate-limit', '--no-spawn'], { encoding: 'utf8', stdio: 'pipe' }));
  const db2 = openDb();
  const after = listRuns(db2).length;
  db2.close();
  assert.equal(after, before);
  assert.ok(!existsSync(join(process.env.AUTODEV_WORKTREES, basename(repo))));
});

test('install-skill: installs autodev + autodev-specs, warns on foreign overwrite, uninstalls', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home }; // homedir() reads USERPROFILE on win32
  execFileSync('node', ['bin/autodev.js', 'install-skill'], { encoding: 'utf8', env });
  const dest = join(home, '.claude/skills/autodev/SKILL.md');
  assert.equal(readFileSync(dest, 'utf8'), readFileSync('skill/SKILL.md', 'utf8'));
  const specDest = join(home, '.claude/skills/autodev-specs/SKILL.md');
  assert.equal(readFileSync(specDest, 'utf8'), readFileSync('skill/autodev-specs/SKILL.md', 'utf8'));
  // a locally-edited skill is not silently clobbered…
  writeFileSync(specDest, 'my local edits\n');
  const out = execFileSync('node', ['bin/autodev.js', 'install-skill'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(readFileSync(specDest, 'utf8'), 'my local edits\n');
  // …unless --force
  execFileSync('node', ['bin/autodev.js', 'install-skill', '--force'], { encoding: 'utf8', env });
  assert.equal(readFileSync(specDest, 'utf8'), readFileSync('skill/autodev-specs/SKILL.md', 'utf8'));
  execFileSync('node', ['bin/autodev.js', 'uninstall-skill'], { encoding: 'utf8', env });
  assert.ok(!existsSync(dest) && !existsSync(specDest));
});

test('install-skill --project installs under ./.claude/skills of the cwd', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'));
  execFileSync('node', [join(process.cwd(), 'bin/autodev.js'), 'install-skill', '--project'],
    { encoding: 'utf8', cwd: proj });
  assert.ok(existsSync(join(proj, '.claude/skills/autodev/SKILL.md')));
  assert.ok(existsSync(join(proj, '.claude/skills/autodev-specs/SKILL.md')));
});

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn, ms = 5000, step = 50) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise(r => setTimeout(r, step));
  }
}

test('stop kills the runner\'s whole process group, including the claude child', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'wt-stop-'));
  const db = openDb();
  const id = createRun(db, { slug: 'stop-test', repo: 'demo', repo_path: worktree, worktree, branch: 'autodev/stop-test', requirement: 'q' });
  db.close();
  mkdirSync(runDir(id), { recursive: true });

  // stub claude that records its own pid then sleeps — simulating a long-running
  // edit/commit/push session still in the runner's process group.
  const pidFile = join(worktree, 'claude.pid');
  const stubDir2 = mkdtempSync(join(tmpdir(), 'stub-sleep-'));
  const sleepStub = stubClaude(stubDir2,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`);

  const log = openSync(join(runDir(id), 'runner.log'), 'a');
  const runner = spawn('node', ['src/runner.js', String(id)],
    { detached: true, stdio: ['ignore', log, log], env: { ...process.env, AUTODEV_CLAUDE_BIN: sleepStub } });
  runner.unref();
  const runnerPid = runner.pid;

  // wait for claude (the stub) to actually be running before we try to stop it
  const claudePid = await waitFor(() => {
    try { return Number(readFileSync(pidFile, 'utf8').trim()) || null; } catch { return null; }
  });
  assert.ok(isAlive(runnerPid), 'runner should still be alive before stop');
  assert.ok(isAlive(claudePid), 'claude stub should still be alive before stop');

  execFileSync('node', ['bin/autodev.js', 'stop', String(id)], { encoding: 'utf8' });

  await waitFor(() => !isAlive(runnerPid) && !isAlive(claudePid) ? true : null);
  assert.ok(!isAlive(runnerPid), 'runner should be dead after stop');
  assert.ok(!isAlive(claudePid), 'claude stub should be dead after stop (not orphaned)');
});

test('autodev run --test-cmd stores the override on the run row', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  execFileSync('node', ['bin/autodev.js', 'run', 'health endpoint two', '--repo', repo, '--no-spawn', '--test-cmd', 'make check'], { encoding: 'utf8' });
  const db = openDb();
  const run = listRuns(db)[0]; db.close();
  assert.equal(run.test_cmd, 'make check');
});

test('autodev run --no-push and --until store the stage cap; bad --until exits', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  execFileSync('node', ['bin/autodev.js', 'run', 'capped run one', '--repo', repo, '--no-spawn', '--no-push'], { encoding: 'utf8' });
  const db = openDb();
  assert.equal(listRuns(db)[0].until_stage, 4); db.close();
  execFileSync('node', ['bin/autodev.js', 'run', 'capped run two', '--repo', repo, '--no-spawn', '--until', 'analyze'], { encoding: 'utf8' });
  const db2 = openDb();
  assert.equal(listRuns(db2)[0].until_stage, 2); db2.close();
  assert.throws(() => execFileSync('node', ['bin/autodev.js', 'run', 'x', '--repo', repo, '--no-spawn', '--until', 'nonsense'], { stdio: 'pipe' }), /--until wants/s);
});

test('run without recorded consent (real claude, no TTY) aborts and explains', () => {
  const env = { ...process.env, AUTODEV_HOME: mkdtempSync(join(tmpdir(), 'consent-')) };
  delete env.AUTODEV_CLAUDE_BIN; // real-claude mode → consent gate applies
  assert.throws(
    () => execFileSync('node', ['bin/autodev.js', 'run', 'x y z', '--no-spawn'], { env, stdio: 'pipe' }),
    /dangerously-skip-permissions[\s\S]*consent/);
});

test('run number comes from the reserved row id, not listRuns() order', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  const db = openDb();
  // A finished run with a HIGHER id than a still-RUNNING one. listRuns() sorts RUNNING
  // first, so runs[0].id is not the maximum — the old `max + 1` numbering read that and
  // handed out an NNN whose branch and worktree already belonged to the finished run.
  const lower = createRun(db, { slug: 'older', repo: 'demo', repo_path: repo, worktree: 'w1', branch: 'b1', requirement: 'q' });
  const higher = createRun(db, { slug: 'newer', repo: 'demo', repo_path: repo, worktree: 'w2', branch: 'b2', requirement: 'q' });
  updateRun(db, higher, { status: 'DONE' });
  assert.equal(listRuns(db)[0].id, lower, 'precondition: listRuns() puts the lower-id RUNNING run first');
  db.close();

  const out = execFileSync('node', ['bin/autodev.js', 'run', 'numbering probe', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  const nnn = String(higher + 1).padStart(3, '0');
  assert.match(out, new RegExp(`run #${higher + 1}\\b`));
  const db2 = openDb();
  const run = getRun(db2, higher + 1); db2.close();
  assert.equal(run.branch, `autodev/${nnn}-numbering-probe`);
  assert.ok(run.worktree.endsWith(`run-${nnn}`), `worktree ${run.worktree} should end in run-${nnn}`);
});

test('a failed worktree add rolls the reserved row back — no ghost run', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  const db = openDb();
  const before = listRuns(db).length;
  db.close();
  // --branch adopts an existing ref; this one does not exist, so `git worktree add` fails
  assert.throws(() => execFileSync('node',
    ['bin/autodev.js', 'run', 'ghost probe', '--repo', repo, '--branch', 'no/such/branch', '--no-spawn'],
    { stdio: 'pipe' }));
  const db2 = openDb();
  assert.equal(listRuns(db2).length, before, 'reserved row must not survive a failed kickoff');
  db2.close();
});

test('no launch site spawns a bare "node" — the interpreter must come from process.execPath', () => {
  // The regression this guards is silent: a PATH 'node' that is missing or older than 22.5
  // (node:sqlite) dies immediately into runner.log, and the run row says RUNNING forever.
  // Structural assertion, because there is no failure to observe.
  const offenders = [];
  for (const dir of ['src', 'bin']) {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const body = readFileSync(join(dir, f), 'utf8');
      body.split('\n').forEach((line, i) => {
        if (/spawn(Sync)?\(\s*['"]node['"]/.test(line)) offenders.push(`${dir}/${f}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `spawn a bare "node" at: ${offenders.join(', ')}`);
});

test('the runner still starts when PATH offers no usable node', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-nopath-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  const db = openDb();
  const id = createRun(db, { slug: 'nopath', repo: 'demo', repo_path: repo, worktree: repo,
    branch: 'main', requirement: 'q' });
  db.close();
  mkdirSync(runDir(id), { recursive: true });

  // A shim dir whose `node` always fails, prepended to PATH. Bare-'node' spawning picks this
  // up and dies; process.execPath ignores PATH entirely. git stays reachable via the real PATH.
  const shim = mkdtempSync(join(tmpdir(), 'shim-'));
  if (process.platform === 'win32') {
    writeFileSync(join(shim, 'node.cmd'), '@exit /b 127\r\n');
  } else {
    writeFileSync(join(shim, 'node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  }
  const env = { ...process.env, PATH: shim + delimiter + process.env.PATH };

  execFileSync(process.execPath, ['bin/autodev.js', 'resume', String(id)], { encoding: 'utf8', env });

  // The stub claude produces no artifact, so stage 1 fails its check and the run parks — but
  // parking is proof the runner executed at all, which is the whole point.
  await waitFor(() => {
    try { return /stage_started/.test(readFileSync(join(runDir(id), 'events.jsonl'), 'utf8')); }
    catch { return null; }
  }, 20000);
});

test('.autodev.json branchPrefix names the run branch', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  writeFileSync(join(repo, '.autodev.json'), JSON.stringify({ branchPrefix: 'feature' }));
  git(repo, ['add', '-A'], commit('cfg'));
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'prefix demo run', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.match(out, /feature\/\d{3}-prefix-demo-run/);
});

test('worktreeCopy lands named untracked files in the fresh worktree; escapes, absentees, and tracked entries are skipped, and copies are excluded from git add', () => {
  // repo nested one level down so the '../escape' fixture file stays inside OUR scratch
  // dir instead of littering the shared system temp root on every suite run.
  const parent = mkdtempSync(join(tmpdir(), 'wtcopy-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  writeFileSync(join(repo, '.gitignore'), 'local.properties\nsecrets/\n');
  writeFileSync(join(repo, '.autodev.json'), JSON.stringify({
    // './committed.txt' on purpose: ls-files prints the NORMALIZED path, so the raw
    // spelling only skips if the lookup key is normalized too.
    worktreeCopy: ['local.properties', 'secrets/dev.env', '../escape', 'not-there.txt', '.', '', './committed.txt']
  }));
  writeFileSync(join(repo, 'local.properties'), 'sdk.dir=C:/Android');
  mkdirSync(join(repo, 'secrets'), { recursive: true });
  writeFileSync(join(repo, 'secrets', 'dev.env'), 'X=1');
  writeFileSync(join(repo, 'committed.txt'), 'tracked content');
  // a real file at the '../escape' entry's SOURCE path: without the escape guard, cpSync
  // would succeed and actually copy it, so the "did not land" assertion below is load-bearing
  // rather than trivially true because nothing existed to copy.
  writeFileSync(join(repo, '..', 'escape'), 'should never be reachable via worktreeCopy');
  git(repo, ['add', '.gitignore', '.autodev.json', 'committed.txt'], commit('cfg'));
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'copy probe run', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  const db = openDb(); const run = listRuns(db)[0]; db.close();
  assert.match(out, /run #\d+/); // kickoff still succeeds despite the skipped entries
  assert.equal(readFileSync(join(run.worktree, 'local.properties'), 'utf8'), 'sdk.dir=C:/Android');
  assert.equal(readFileSync(join(run.worktree, 'secrets', 'dev.env'), 'utf8'), 'X=1');
  assert.match(out, /\.\.\/escape escapes the repo, skipped/);
  assert.match(out, /not-there\.txt not present, skipped/);
  assert.match(out, /worktreeCopy: \. escapes the repo, skipped/);
  assert.match(out, /worktreeCopy: {2}escapes the repo, skipped/); // the '' entry
  assert.match(out, /\.\/committed\.txt is tracked, the worktree already has it, skipped/);
  assert.ok(!existsSync(join(run.worktree, '..', 'escape')));
  // the exclude write works: `git add -A` in the worktree must not pick up the copies
  const dryRun = execFileSync('git', ['add', '-A', '--dry-run'], { cwd: run.worktree, encoding: 'utf8' });
  assert.doesNotMatch(dryRun, /local\.properties/);
  assert.doesNotMatch(dryRun, /secrets[\\/]dev\.env/);
});

test('a worktreeCopy entry that fails mid-copy is skipped with a reason; the run row still gets branch and worktree', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main']);
  // 'secrets' is committed as a plain FILE, so the fresh worktree checks it out as a file.
  writeFileSync(join(repo, 'secrets'), 'placeholder');
  git(repo, ['add', 'secrets'], commit('secrets as a file'));
  // Locally (uncommitted) replace it with a directory holding an untracked config file.
  // 'secrets/dev.env' as a PATH is not itself a tracked index entry (only 'secrets' the blob
  // is), so it reaches the copy attempt; but the fresh worktree still has 'secrets' checked
  // out as a FILE from HEAD, so mkdirSync-ing a directory at that path throws mid-copy. This
  // is the case FIX 1 has to survive without losing the run row.
  rmSync(join(repo, 'secrets'));
  mkdirSync(join(repo, 'secrets'), { recursive: true });
  writeFileSync(join(repo, 'secrets', 'dev.env'), 'X=1');
  writeFileSync(join(repo, '.autodev.json'), JSON.stringify({ worktreeCopy: ['secrets/dev.env'] }));
  git(repo, ['add', '.autodev.json'], commit('cfg'));
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'copy fail probe', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.match(out, /run #\d+/);
  assert.match(out, /worktreeCopy: secrets\/dev\.env could not be copied \(.+\), skipped/);
  assert.doesNotMatch(out, /secrets\/dev\.env -> worktree/);
  const db = openDb(); const run = listRuns(db)[0]; db.close();
  assert.ok(run.branch && run.worktree, 'a failed copy must not leave branch/worktree unset on the row');
  assert.equal(run.status, 'RUNNING');
});

test('a repo without worktreeCopy kicks off exactly as before (no copy lines, no crash)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  const out = execFileSync('node', ['bin/autodev.js', 'run', 'no worktree copy config here', '--repo', repo, '--no-spawn'], { encoding: 'utf8' });
  assert.doesNotMatch(out, /worktreeCopy:/);
  assert.match(out, /run #\d+/);
});

test('autodev init scaffolds the guidance layer and never clobbers an edited one', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'));
  const out = execFileSync('node', ['bin/autodev.js', 'init', '--repo', repo], { encoding: 'utf8' });
  assert.match(out, /created \.autodev\/mission\.md/);
  assert.match(out, /created \.autodev\/factory-rules\.md/);
  assert.match(readFileSync(join(repo, '.autodev/mission.md'), 'utf8'), /Non-goals/);
  assert.match(readFileSync(join(repo, '.autodev/factory-rules.md'), 'utf8'), /One task at a time/);

  // second run must leave the operator's edits alone — this is the file that decides what
  // the factory refuses, and overwriting it would silently widen scope
  writeFileSync(join(repo, '.autodev/mission.md'), '# Mine\n');
  const again = execFileSync('node', ['bin/autodev.js', 'init', '--repo', repo], { encoding: 'utf8' });
  assert.match(again, /kept    \.autodev\/mission\.md/);
  assert.equal(readFileSync(join(repo, '.autodev/mission.md'), 'utf8'), '# Mine\n');
});

test('usage names the new commands', () => {
  const out = execFileSync('node', ['bin/autodev.js'], { encoding: 'utf8' });
  for (const c of ['init', 'daemon', '--issue', '--auto-accept']) assert.match(out, new RegExp(c.replace(/[-]/g, '\\-')));
});
