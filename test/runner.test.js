import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, commit, stubClaude, pipelineStubJs, failingStubJs, sessionsFrom, repoWithSpecs } from './helpers.js';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-run-'));
// Never let a test runner's events reach a live dashboard on 4590: its run ids overlap real
// ones, and the server applies parked/run_done events straight onto the matching db row.
process.env.AUTODEV_PORT = '0';
const { openDb, createRun, getRun, runDir } = await import('../src/db.js');

// Stub claude: reads the -p prompt, fabricates the right artifact per stage keyword.
const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
const stubPath = stubClaude(stubDir, pipelineStubJs(join(stubDir, 'calls')));
process.env.AUTODEV_CLAUDE_BIN = stubPath;

function makeRepoWithWorktree({ testMarker = true } = {}) {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  git(origin, ['init', '-q', '--bare']);
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  git(wt, ['init', '-q'], commit('init', '--allow-empty'),
    ['remote', 'add', 'origin', origin], ['checkout', '-qb', 'autodev/001-x']);
  if (testMarker) {
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
    git(wt, ['add', '-A'], commit('pkg'));
  }
  return wt;
}

test('runner drives a run through all seven stages to DONE', () => {
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
  writeFileSync(stubPath, readFileSync(stubPath, 'utf8')
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
  assert.equal(run.stage, 6);
  assert.ok(existsSync(join(runDir(id), 'blocked.md')));
  // internal review budget (3 rounds + 2 fixes) must not be multiplied by outer retries
  const reviewCalls = readFileSync(join(stubDir, 'calls'), 'utf8')
    .split('\n').filter(l => /code.review/.test(l));
  assert.equal(reviewCalls.length, 5, `expected 5 review-stage claude calls, got ${reviewCalls.length}`);
  // fix the stub, resume
  writeFileSync(stubPath, readFileSync(stubPath, 'utf8')
    .replace('REQUEST_CHANGES', 'APPROVE'));
  execFileSync('node', ['src/runner.js', String(id), '--resume'], { env: process.env });
  const db3 = openDb();
  assert.equal(getRun(db3, id).status, 'DONE'); db3.close();
});

test('runner PARKS when no test command is detectable — never a vacuous pass', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree({ testMarker: false });
  const id = createRun(db, { slug: 'z', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.stage, 7);
  assert.match(run.blocked_reason, /no test command/);
});

test('.autodev.json testCmd overrides detection and unblocks the same repo', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree({ testMarker: false });
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ testCmd: 'node -e ""' }));
  git(wt, ['add', '-A'], commit('cfg'));
  const id = createRun(db, { slug: 'w', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  assert.equal(getRun(db2, id).status, 'DONE'); db2.close();
});

test('spend never parks a run: a maxCostUsd in .autodev.json is ignored; cost CLI still sums metrics', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree();
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ maxCostUsd: 1 }));
  git(wt, ['add', '-A'], commit('cfg'));
  // stub emits a claude result JSON costing $2 per session and produces no artifacts — the
  // run must exhaust its retry budget on the missing spec, never stop on the price (specs/003).
  const costStub = mkdtempSync(join(tmpdir(), 'cost-stub-'));
  const stub = stubClaude(costStub,
    `process.stdout.write(JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 2, usage: { input_tokens: 10, output_tokens: 5 } }));`);
  const id = createRun(db, { slug: 'c', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: { ...process.env, AUTODEV_CLAUDE_BIN: stub } });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'BLOCKED');
  assert.doesNotMatch(run.blocked_reason, /cost budget/);
  assert.match(run.blocked_reason, /no specs\/NNN-\* directory found/);
  const out = execFileSync('node', ['bin/autodev.js', 'cost', String(id)], { encoding: 'utf8' });
  assert.match(out, /stage 1 Spec/);
  assert.match(out, /3 session\(s\)/); // every retry was allowed to run
  assert.match(out, /\$6\.00/);
});

test('--until: runner stops cleanly after the named stage, DONE not BLOCKED', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree();
  const id = createRun(db, { slug: 'u', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo', until_stage: 2 });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'DONE');
  assert.equal(run.stage, 2); // never advanced past Analyze
  const events = readFileSync(join(runDir(id), 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /"stage":5,"detail":"Push"/); // push never started
  assert.match(events, /stopped after stage 2/);
});

// ---- park diagnosis (US1) / terminal classification (US2) / resume seeding (US4) ----

// A distinctive slice of the stage-1 prompt. If this ever appears in a park reason, the
// pipeline is reporting its own instruction as the diagnosis — the defect this feature fixes.
const PROMPT_FRAGMENT = 'First check specs/ for an existing spec set';

function runWithStub(stubJs, { resumeOf = null, worktree = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stub-fail-'));
  const bin = stubClaude(dir, stubJs);
  const wt = worktree ?? makeRepoWithWorktree();
  let id = resumeOf;
  if (!id) {
    const db = openDb();
    id = createRun(db, { slug: 'p', repo: 'demo', repo_path: wt, worktree: wt,
      branch: 'autodev/001-x', requirement: 'demo' });
    db.close();
  }
  execFileSync(process.execPath, ['src/runner.js', String(id), ...(resumeOf ? ['--resume'] : [])],
    { env: { ...process.env, AUTODEV_CLAUDE_BIN: bin } });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  return { id, run, wt };
}

test('a park reason is built from the session output, never from the stage prompt', () => {
  const { id, run } = runWithStub(failingStubJs({ stdout: 'FATAL: the frobnicator is missing\n' }));
  assert.equal(run.status, 'BLOCKED');
  assert.match(run.blocked_reason, /frobnicator is missing/);
  assert.doesNotMatch(run.blocked_reason, /Command failed/);
  assert.ok(!run.blocked_reason.includes(PROMPT_FRAGMENT), // SC-001, checked not asserted
    `park reason echoed the prompt: ${run.blocked_reason}`);
  assert.ok(!readFileSync(join(runDir(id), 'blocked.md'), 'utf8').includes(PROMPT_FRAGMENT));
});

test('retry events carry the real reason, and blocked.md keeps stderr as well as stdout', () => {
  const { id, run } = runWithStub(failingStubJs({
    stdout: 'stdout-side detail\n', stderr: 'stderr-side detail\n' }));
  const events = readFileSync(join(runDir(id), 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const retries = events.filter(e => e.type === 'retry');
  assert.equal(retries.length, 2, 'two retries before the park');
  for (const r of retries) assert.ok(!r.detail.includes(PROMPT_FRAGMENT), `retry echoed the prompt: ${r.detail}`);
  const blocked = readFileSync(join(runDir(id), 'blocked.md'), 'utf8');
  assert.match(blocked, /stdout-side detail/);
  assert.match(blocked, /stderr-side detail/); // used to be dropped entirely
  assert.ok(run.blocked_reason.length > 0);
});

test('a failing session leaves an attributed block in runner.log; a successful one leaves none', () => {
  const { id } = runWithStub(failingStubJs({ stdout: 'boom one\n', stderr: 'boom two\n' }));
  const log = readFileSync(join(runDir(id), 'runner.log'), 'utf8');
  assert.match(log, /--- run \d+ · stage 1 \(Spec\) · attempt 1 · exit 1/);
  assert.match(log, /--- run \d+ · stage 1 \(Spec\) · attempt 3 · exit 1/); // 3 sessions, each attributed
  assert.match(log, /\[stdout\]\nboom one/);
  assert.match(log, /\[stderr\]\nboom two/);
  assert.ok(!log.includes(PROMPT_FRAGMENT), 'the block must not carry the prompt');

  // A clean run writes nothing extra (FR-025) — retention is failing attempts only.
  const db = openDb();
  const wt = makeRepoWithWorktree();
  const okId = createRun(db, { slug: 'clean', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync(process.execPath, ['src/runner.js', String(okId)], { env: process.env });
  const okLog = existsSync(join(runDir(okId), 'runner.log'))
    ? readFileSync(join(runDir(okId), 'runner.log'), 'utf8') : '';
  assert.doesNotMatch(okLog, /--- run \d+ · stage/);
});

test('a session larger than the old 1 MiB buffer no longer parks the run for the wrong reason', () => {
  // 2 MiB on stdout, exit 0. Under the default maxBuffer this raised ENOBUFS and killed the
  // child, parking the run on a failure that had nothing to do with the work.
  // exit() inside the write callback: process.exit() discards a large pending stdout write,
  // so a naive stub never actually delivers the megabytes it claims to.
  const { run } = runWithStub(`process.stdout.write('z'.repeat(2*1024*1024), () => process.exit(0));`);
  assert.equal(run.status, 'BLOCKED');            // no artifact, so stage 1 still fails its check
  assert.match(run.blocked_reason, /specs\/NNN|spec artifact/); // …but for the RIGHT reason
  assert.doesNotMatch(run.blocked_reason, /ENOBUFS|buffer/);
});

test('a runaway failing session produces a clamped block, not an unbounded one', () => {
  const { id } = runWithStub(`process.stdout.write('z'.repeat(3*1024*1024), () => process.exit(1));`);
  const log = readFileSync(join(runDir(id), 'runner.log'), 'utf8');
  assert.match(log, /bytes elided/);
  // Three attempts × 3 MiB unclamped would be ~9 MiB; each block is capped at 1 MiB per channel.
  assert.ok(log.length < 4 * 1024 * 1024, `blocks must be clamped, log is ${log.length} bytes`);
});

for (const [label, stub, remedy] of [
  ['not signed in', failingStubJs({ stdout: 'Not logged in · Please run /login\n' }), /sign in/],
  ['usage exhausted', failingStubJs({ stdout: 'Claude usage limit reached\n' }), /reset|raise/],
]) {
  test(`terminal condition (${label}) parks after ONE session and names the remedy`, () => {
    const record = join(mkdtempSync(join(tmpdir(), 'rec-')), 'sessions');
    const withRecord = stub.replace('const p = String(process.argv[3] ?? \'\');',
      `const p = String(process.argv[3] ?? ''); fs.appendFileSync(${JSON.stringify(record)}, '1\\n');`);
    const { run } = runWithStub(withRecord);
    assert.equal(run.status, 'BLOCKED');
    assert.equal(sessionsFrom(record).length || readFileSync(record, 'utf8').trim().split('\n').length, 1,
      'a terminal condition must cost exactly one session, not three');
    assert.match(run.blocked_reason, remedy);
  });
}

test('an unrecognised failure still gets the full retry budget — classification fails open', () => {
  const record = join(mkdtempSync(join(tmpdir(), 'rec-')), 'sessions');
  const { run } = runWithStub(failingStubJs({ stdout: 'TypeError: nope\n', recordTo: record }));
  assert.equal(run.status, 'BLOCKED');
  assert.equal(sessionsFrom(record).length, 3, 'unmatched failures keep the existing behaviour');
});

test('a SUCCESSFUL session whose output quotes a terminal phrase does not park the run', () => {
  // The model reasoning about an auth error must never be mistaken for one (FR-012).
  const quoting = pipelineStubJs().replace(
    'const git =', 'process.stdout.write("I considered whether Not logged in applied here\\n");\nconst git =');
  const { run } = runWithStub(quoting);
  assert.equal(run.status, 'DONE');
});

test('resume carries the previous park reason into the resumed stage', () => {
  const { id, wt } = runWithStub(failingStubJs({ stdout: 'WIDGET_FROBNICATOR_MISSING\n' }));
  const record = join(mkdtempSync(join(tmpdir(), 'rec-')), 'sessions');
  runWithStub(failingStubJs({ stdout: 'still broken\n', recordTo: record }), { resumeOf: id, worktree: wt });
  const prompts = sessionsFrom(record).map(s => s.prompt);
  assert.ok(prompts.length, 'the resumed stage ran at least one session');
  assert.match(prompts[0], /A previous attempt failed its verification/);
  assert.match(prompts[0], /WIDGET_FROBNICATOR_MISSING/);
});

test('resuming a run that never parked invents no previous failure', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree();
  const id = createRun(db, { slug: 'np', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  const record = join(mkdtempSync(join(tmpdir(), 'rec-')), 'sessions');
  runWithStub(failingStubJs({ stdout: 'fresh failure\n', recordTo: record }), { resumeOf: id, worktree: wt });
  assert.doesNotMatch(sessionsFrom(record)[0].prompt, /A previous attempt failed/);
});

test('two consecutive resumes carry one reason, not two concatenated', () => {
  const { id, wt } = runWithStub(failingStubJs({ stdout: 'FIRST_CAUSE\n' }));
  runWithStub(failingStubJs({ stdout: 'SECOND_CAUSE\n' }), { resumeOf: id, worktree: wt });
  const record = join(mkdtempSync(join(tmpdir(), 'rec-')), 'sessions');
  runWithStub(failingStubJs({ stdout: 'third\n', recordTo: record }), { resumeOf: id, worktree: wt });
  const p = sessionsFrom(record)[0].prompt;
  assert.match(p, /SECOND_CAUSE/);
  assert.doesNotMatch(p, /FIRST_CAUSE/, 'the seed must not accumulate across resumes');
});

// ---- spec pinning (US5) ----

test('a fresh run pins the spec its own stage 1 created, not the highest-numbered one', () => {
  // The repo already holds specs numbered ABOVE the one the stub writes (specs/001-x), so
  // "highest-numbered wins" would pin somebody else's spec.
  const wt = makeRepoWithWorktree();
  repoWithSpecs(wt, ['015-existing', '020-existing']);
  const db = openDb();
  const id = createRun(db, { slug: 'pin', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync(process.execPath, ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.spec_dir, 'specs/001-x', `pinned ${run.spec_dir}, expected the one stage 1 created`);
});

test('an adopted spec survives into every later stage, and is named in their prompts', () => {
  const wt = makeRepoWithWorktree();
  repoWithSpecs(wt, ['004-chosen', '015-decoy']);
  const record = join(mkdtempSync(join(tmpdir(), 'rec-')), 'sessions');
  const dir = mkdtempSync(join(tmpdir(), 'stub-pin-'));
  // Record every prompt, then behave like the normal pipeline stub.
  const bin = stubClaude(dir, `require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ prompt: String(process.argv[3] ?? '') }) + '\\n');\n`
    + pipelineStubJs());
  const db = openDb();
  const id = createRun(db, { slug: 'adopt', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo', stage: 2, spec_dir: 'specs/004-chosen' });
  db.close();
  execFileSync(process.execPath, ['src/runner.js', String(id)], { env: { ...process.env, AUTODEV_CLAUDE_BIN: bin } });

  const prompts = sessionsFrom(record).map(s => s.prompt);
  const specMentions = prompts.filter(p => /specs\/00\d|specs\/01\d|newest specs/.test(p));
  assert.ok(specMentions.length >= 2, 'the analyze/implement/verify prompts name a spec');
  for (const p of specMentions) {
    assert.match(p, /specs\/004-chosen/);
    assert.doesNotMatch(p, /015-decoy|the newest specs/);
  }
  const db2 = openDb();
  assert.equal(getRun(db2, id).spec_dir, 'specs/004-chosen', 'the pin is never overwritten'); db2.close();
});

test('.autodev.json "push": false caps the run at Verify', () => {
  const db = openDb();
  const wt = makeRepoWithWorktree();
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ push: false }));
  git(wt, ['add', '-A'], commit('cfg'));
  const id = createRun(db, { slug: 'np', repo: 'demo', repo_path: wt, worktree: wt,
    branch: 'autodev/001-x', requirement: 'demo' });
  db.close();
  execFileSync('node', ['src/runner.js', String(id)], { env: process.env });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  assert.equal(run.status, 'DONE');
  assert.equal(run.stage, 4); // Verify is the last stage that ran
});

// ---- pushMode "direct": no pull request, the runner lands the branch itself ----
// origin has a real main; the worktree branch is one commit ahead of it, and main moves
// under the run before deploy — the shape that made run #9's `gh pr merge --rebase` fail.
function makeDirectRepo(cfg = {}) {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  git(origin, ['init', '-q', '--bare']);
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  git(wt, ['init', '-q', '-b', 'main'], commit('init', '--allow-empty'), ['remote', 'add', 'origin', origin]);
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ pushMode: 'direct', baseBranch: 'main',
    skip: ['spec', 'analyze', 'verify', 'review'],
    deploy: { merge: true, cmd: 'node -e "console.log(\'deployed\')"',
      proofCmd: 'node -e "require(\'fs\').writeFileSync(process.env.AUTODEV_PROOF_DIR + \'/shot.txt\', \'ok\')"' },
    ...cfg }));
  git(wt, ['add', '-A'], commit('pkg'), ['push', '-q', '-u', 'origin', 'main'], ['checkout', '-qb', 'autodev/001-x']);
  writeFileSync(join(wt, 'feature.txt'), 'built\n');
  // main moves: somebody else lands a commit on origin/main while this run is in flight
  const other = mkdtempSync(join(tmpdir(), 'other-'));
  git(other, ['clone', '-q', origin, '.']);
  writeFileSync(join(other, 'elsewhere.txt'), 'landed by another run\n');
  git(other, ['add', '-A'], commit('elsewhere'), ['push', '-q', 'origin', 'main']);
  return { wt, origin };
}
// A stub that answers `auth status` and otherwise implements spec-less: commit what is there.
// implement=false: a session that burns its turn and writes nothing — the shape that let
// run #19 reach deploy on an empty branch.
const directStubJs = (calls, { loggedIn = true, implement = true, landEarly = false } = {}) => `
const fs = require('node:fs'); const cp = require('node:child_process');
if (process.argv[2] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: ${loggedIn}, email: 'x@y' })); process.exit(0); }
const p = String(process.argv[3] ?? '');
fs.appendFileSync(${JSON.stringify(calls)}, p.slice(0, 40) + '\\n');
${implement ? `
cp.execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
cp.execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'impl'], { stdio: 'ignore' });
${landEarly ? `
// The run's own work reaches the base before stage 8 looks — somebody merging the branch,
// a second session pushing it, a queue reconciling it. Run #564's shape.
cp.execFileSync('git', ['fetch', '-q', 'origin', 'main'], { stdio: 'ignore' });
cp.execFileSync('git', ['rebase', '-q', 'origin/main'], { stdio: 'ignore' });
cp.execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { stdio: 'ignore' });
` : ''}
` : `
// the session wrote nothing and left the tree exactly as it found it — run #19's shape,
// which the uncommitted-changes guard does not catch
cp.execFileSync('git', ['clean', '-fdq'], { stdio: 'ignore' });
`}`;
function runDirect({ loggedIn = true, implement = true, landEarly = false, before = () => {}, cfg = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stub-direct-'));
  const calls = join(dir, 'calls'); writeFileSync(calls, '');
  const bin = stubClaude(dir, directStubJs(calls, { loggedIn, implement, landEarly }));
  const { wt, origin } = makeDirectRepo(cfg);
  const db = openDb();
  const id = createRun(db, { slug: 'd', repo: 'demo', repo_path: wt, worktree: wt, branch: 'autodev/001-x', requirement: 'ship feature.txt' });
  db.close();
  before({ id, wt });
  execFileSync(process.execPath, ['src/runner.js', String(id)], { env: { ...process.env, AUTODEV_CLAUDE_BIN: bin } });
  const db2 = openDb();
  const run = getRun(db2, id); db2.close();
  const events = readFileSync(join(runDir(id), 'events.jsonl'), 'utf8');
  return { id, run, wt, origin, events, calls: readFileSync(calls, 'utf8') };
}

test('pushMode direct: no PR, no push session — the runner rebases, pushes, and fast-forwards main after tests', () => {
  const { run, origin, events, calls } = runDirect();
  assert.equal(run.status, 'DONE', run.blocked_reason ?? '');
  assert.equal(run.pr_url, null);
  assert.doesNotMatch(calls, /ce-commit-push-pr/, 'the push stage must not spend a session');
  assert.match(events, /"type":"pushed".*rebased onto origin\/main/);
  assert.match(events, /"type":"merged".*fast-forward, pushMode direct/);
  assert.match(events, /"type":"deployed"/);
  // main carries both the other run's commit and ours, in that order — a rebase, not a merge
  const log = execFileSync('git', ['log', '--format=%s', 'main'], { cwd: origin, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(log.slice(0, 2), ['impl', 'elsewhere']);
  assert.match(events, /"label"|shot\.txt/);
});

test('pushMode direct: a run whose implement stage wrote nothing parks instead of deploying an empty branch', () => {
  const { run, origin, events } = runDirect({ implement: false });
  assert.equal(run.status, 'BLOCKED');
  assert.match(run.blocked_reason, /nothing to land.*no commits over origin\/main/);
  // nothing was deployed, and nothing was reported as merged — the ticket stays open
  assert.doesNotMatch(events, /"type":"deployed"/);
  assert.doesNotMatch(events, /"type":"merged"/);
  // main still carries only the other run's commit; this run landed nothing
  const log = execFileSync('git', ['log', '--format=%s', 'main'], { cwd: origin, encoding: 'utf8' }).trim().split('\n');
  assert.equal(log[0], 'elsewhere');
});

test('pushMode direct: a run whose own commits already reached the base lands rather than parking', () => {
  // Run #564. The branch wrote code, the code reached main before stage 8 looked, and the
  // land check — "is HEAD an ancestor of origin/main" — reads the same on a branch that
  // wrote nothing. It parked with "the implement stage produced no code" while its work sat
  // on main, deployed, and its ticket stayed open. What separates the two is whether the
  // Implement stage itself wrote a commit, which is measured in the worktree while it runs.
  const { run, events } = runDirect({ landEarly: true });
  assert.equal(run.status, 'DONE', run.blocked_reason ?? '');
  assert.match(events, /"type":"merged".*landed outside this attempt/);
  assert.match(events, /"type":"deployed"/);
});

test('auth preflight: a signed-out CLI parks before any session is spent, and says how to sign in', () => {
  const { run, calls } = runDirect({ loggedIn: false });
  assert.equal(run.status, 'BLOCKED');
  assert.equal(calls, '', 'no session may be bought against a CLI that cannot authenticate');
  assert.match(run.blocked_reason, /not signed in.*\/login/);
});

test('deploy lock: a lock left by a dead runner is reclaimed, not waited on', async () => {
  const { createHash } = await import('node:crypto');
  const { run, events } = runDirect({ before: ({ wt }) => {
    const dir = join(process.env.AUTODEV_HOME, 'locks', `deploy-${createHash('sha1').update(wt).digest('hex').slice(0, 12)}`);
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(dir)}, { recursive: true });
      require('fs').writeFileSync(${JSON.stringify(join(dir, 'owner.json'))}, JSON.stringify({ run: 999, pid: 2147483000 }))`]);
  } });
  assert.equal(run.status, 'DONE', run.blocked_reason ?? '');
  assert.match(events, /deploy lock left by dead run #999.*reclaimed/);
  assert.match(events, /"type":"deployed"/);
});

test('pushMode direct: a rebase conflict parks the run naming the branch, and leaves no rebase in progress', () => {
  const { run, wt } = runDirect({ before: ({ wt }) => {
    // the other side already landed elsewhere.txt; our branch will commit a different one
    writeFileSync(join(wt, 'elsewhere.txt'), 'conflicting content\n');
  } });
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.stage, 5);
  assert.match(run.blocked_reason, /rebase onto origin\/main conflicts.*autodev\/001-x/);
  assert.ok(!existsSync(join(wt, '.git', 'rebase-merge')) && !existsSync(join(wt, '.git', 'rebase-apply')), 'rebase must be aborted');
});
