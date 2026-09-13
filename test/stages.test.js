import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { STAGES, scheduledStages, findSpecDir, specDirOf, detectTestCmd, specDirFor, isCompleteSpecDir,
         markerSubdirs, hasTestSources, untilStage, hasSpecSet, designRefs, designCompares, designBriefs,
         designScores, designGate, designScript, DESIGN_DEFAULTS } from '../src/stages.js';
import { git, commit } from './helpers.js';

function gitRepo() {
  const d = mkdtempSync(join(tmpdir(), 'wt-'));
  git(d, ['init', '-q'], commit('init', '--allow-empty'));
  return d;
}

test('stage table shape', () => {
  assert.deepEqual(STAGES.map(s => s.key), ['spec', 'analyze', 'implement', 'verify', 'push', 'review', 'test', 'deploy']);
  for (const s of STAGES) assert.ok(s.n >= 1 && s.title && typeof s.check === 'function');
});

test('deploy is scheduled only when the repo configures it', () => {
  assert.deepEqual(scheduledStages({}).map(s => s.key).at(-1), 'test');
  assert.equal(scheduledStages({}).length, 7);
  assert.equal(scheduledStages({ deploy: { cmd: './ship.sh' } }).length, 8);
  assert.deepEqual(scheduledStages({ deploy: { merge: true } }).at(-1).key, 'deploy');
});

test('findSpecDir picks newest specs/NNN-*', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, 'specs/001-old'), { recursive: true });
  mkdirSync(join(wt, 'specs/002-new'), { recursive: true });
  assert.match(findSpecDir(wt), /002-new$/);
});

test('specDirOf prefers the run\'s pinned directory over the highest-numbered one', () => {
  const wt = gitRepo();
  for (const n of ['001-chosen', '002-other', '015-newest']) mkdirSync(join(wt, 'specs', n), { recursive: true });
  assert.match(specDirOf({ worktree: wt, spec_dir: 'specs/001-chosen' }), /001-chosen$/);
  assert.match(specDirOf({ worktree: wt }), /015-newest$/, 'unpinned keeps the old behaviour');
});

test('specDirOf falls back rather than failing when the pin is not in this worktree', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, 'specs/003-present'), { recursive: true });
  // deleted, renamed, or recorded against a different worktree — never a reason to park
  assert.match(specDirOf({ worktree: wt, spec_dir: 'specs/099-vanished' }), /003-present$/);
  // …and a pin pointing at a file rather than a directory is equally not a directory
  writeFileSync(join(wt, 'specs/notadir'), 'x');
  assert.match(specDirOf({ worktree: wt, spec_dir: 'specs/notadir' }), /003-present$/);
  assert.equal(specDirOf({ worktree: gitRepo(), spec_dir: 'specs/099-vanished' }), null);
});

test('stage checks and prompts both follow the pin — they cannot disagree', () => {
  const wt = gitRepo();
  const body = '# doc\ncontent......................\n';
  for (const n of ['001-chosen', '015-newest']) {
    mkdirSync(join(wt, 'specs', n, 'checklists'), { recursive: true });
    for (const f of ['spec.md', 'plan.md']) writeFileSync(join(wt, 'specs', n, f), body);
  }
  // Only the PINNED spec has an unchecked task; the newest is complete.
  writeFileSync(join(wt, 'specs/001-chosen/tasks.md'), '- [ ] T001 unfinished\n');
  writeFileSync(join(wt, 'specs/015-newest/tasks.md'), '- [x] T001 done\n');
  const run = { worktree: wt, spec_dir: 'specs/001-chosen' };

  const implement = STAGES.find(s => s.key === 'implement');
  assert.throws(() => implement.check(run), /T001/, 'the check must read the pinned tasks.md');
  for (const key of ['analyze', 'implement', 'verify']) {
    const p = STAGES.find(s => s.key === key).prompt(run);
    assert.match(p, /specs\/001-chosen/, `stage ${key} prompt must name the pinned spec`);
    assert.doesNotMatch(p, /the newest specs/, `stage ${key} prompt must not say "newest" when pinned`);
  }
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
  git(wt, ['add', '-A'], commit('done'));
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

test('detectTestCmd finds gradle at root and markers one level down', () => {
  const g = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(g, 'build.gradle'), '');
  assert.equal(detectTestCmd(g), 'gradle test');
  writeFileSync(join(g, 'gradlew'), '');
  assert.equal(detectTestCmd(g), process.platform === 'win32' ? '.\\gradlew.bat test' : './gradlew test');
  // marker only in a subdir → command cd's into it
  const m = mkdtempSync(join(tmpdir(), 'p-'));
  mkdirSync(join(m, 'backend'));
  writeFileSync(join(m, 'backend', 'pytest.ini'), '');
  assert.equal(detectTestCmd(m), `cd ${JSON.stringify(join(m, 'backend'))} && pytest -q`);
  // dotdirs and node_modules are never scanned
  const n = mkdtempSync(join(tmpdir(), 'p-'));
  mkdirSync(join(n, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(n, 'node_modules', 'x', 'pytest.ini'), '');
  assert.equal(detectTestCmd(n), null);
});

test('win32: the detected gradlew command survives NoDefaultCurrentDirectoryInExePath=1', { skip: process.platform !== 'win32' }, () => {
  const g = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(g, 'build.gradle'), '');
  writeFileSync(join(g, 'gradlew'), '');
  writeFileSync(join(g, 'gradlew.bat'), '@echo gradle-ok\r\n');
  const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' };
  // the bare form is exactly what that env var breaks...
  assert.throws(() => execSync('gradlew.bat test', { cwd: g, env, stdio: 'pipe' }), /is not recognized/);
  // ...and the detected form must keep working
  assert.match(execSync(detectTestCmd(g), { cwd: g, env, encoding: 'utf8' }), /gradle-ok/);
  // the composed subdir form (cd "<sub>" && .\gradlew.bat test) must survive it too
  const s = mkdtempSync(join(tmpdir(), 'p-'));
  mkdirSync(join(s, 'app'));
  writeFileSync(join(s, 'app', 'build.gradle'), '');
  writeFileSync(join(s, 'app', 'gradlew'), '');
  writeFileSync(join(s, 'app', 'gradlew.bat'), '@echo gradle-ok\r\n');
  assert.match(execSync(detectTestCmd(s), { cwd: s, env, encoding: 'utf8' }), /gradle-ok/);
});

test('detectTestCmd finds tox / requirements+tests / Makefile test target / csproj', () => {
  const t = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(t, 'tox.ini'), '[tox]');
  assert.equal(detectTestCmd(t), 'tox -q');
  const r = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(r, 'requirements.txt'), 'pytest');
  assert.equal(detectTestCmd(r), null); // requirements alone is not enough
  mkdirSync(join(r, 'tests'));
  assert.equal(detectTestCmd(r), 'python -m pytest -q');
  const m = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(m, 'Makefile'), 'build:\n\techo hi\ntest:\n\techo t\n');
  assert.equal(detectTestCmd(m), 'make test');
  const m2 = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(m2, 'Makefile'), 'build:\n\techo hi\n'); // no test target
  assert.equal(detectTestCmd(m2), null);
  const c = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(c, 'App.csproj'), '<Project/>');
  assert.equal(detectTestCmd(c), 'dotnet test');
});

function completeSpec(wt, dirName) {
  const d = join(wt, 'specs', dirName);
  mkdirSync(d, { recursive: true });
  for (const f of ['spec.md', 'plan.md', 'tasks.md']) writeFileSync(join(d, f), '# content\n');
  return d;
}

test('specDirFor: single matching complete dir wins', () => {
  const wt = gitRepo();
  const d = completeSpec(wt, '001-rate-limit-api');
  assert.equal(specDirFor(wt, 'add rate limit to api'), d);
});

test('specDirFor: no matching dir returns null', () => {
  const wt = gitRepo();
  completeSpec(wt, '001-rate-limit-api');
  assert.equal(specDirFor(wt, 'build a totally unrelated dashboard widget'), null);
});

test('specDirFor: two matching dirs is ambiguous, returns null', () => {
  const wt = gitRepo();
  completeSpec(wt, '001-rate-limit-api');
  completeSpec(wt, '002-rate-limit-web');
  assert.equal(specDirFor(wt, 'add rate limit everywhere'), null);
});

test('specDirFor: matching dir with incomplete tasks.md is ignored', () => {
  const wt = gitRepo();
  const d = join(wt, 'specs', '001-rate-limit-api');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'spec.md'), '# content\n');
  writeFileSync(join(d, 'plan.md'), '# content\n');
  writeFileSync(join(d, 'tasks.md'), ''); // empty -> incomplete
  assert.equal(specDirFor(wt, 'add rate limit to api'), null);
});

test('isCompleteSpecDir: true only when spec/plan/tasks all non-empty', () => {
  const wt = gitRepo();
  const d = completeSpec(wt, '001-x');
  assert.equal(isCompleteSpecDir(d), true);
  assert.equal(isCompleteSpecDir(join(wt, 'specs', 'nope')), false);
});

test('review check reads .autodev/review.json verdict', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, '.autodev'), { recursive: true });
  assert.throws(() => STAGES[5].check({ worktree: wt }), /review/i);
  writeFileSync(join(wt, '.autodev/review.json'), JSON.stringify({ verdict: 'REQUEST_CHANGES', findings: [{ t: 'x' }] }));
  assert.throws(() => STAGES[5].check({ worktree: wt }), /REQUEST_CHANGES/);
  writeFileSync(join(wt, '.autodev/review.json'), JSON.stringify({ verdict: 'APPROVE', findings: [] }));
  STAGES[5].check({ worktree: wt }); // no throw
});

test('verify check gates on .autodev/verify.json verdict and severity', () => {
  const wt = gitRepo();
  mkdirSync(join(wt, '.autodev'), { recursive: true });
  assert.throws(() => STAGES[3].check({ worktree: wt }), /verify/i);
  writeFileSync(join(wt, '.autodev/verify.json'), JSON.stringify({ verdict: 'FAIL', findings: [{ severity: 'CRITICAL' }] }));
  assert.throws(() => STAGES[3].check({ worktree: wt }), /FAIL/);
  writeFileSync(join(wt, '.autodev/verify.json'), JSON.stringify({ verdict: 'PASS', findings: [{ severity: 'HIGH' }] }));
  assert.throws(() => STAGES[3].check({ worktree: wt }), /critical\/high/i); // PASS with HIGH finding still blocks
  writeFileSync(join(wt, '.autodev/verify.json'), JSON.stringify({ verdict: 'PASS', findings: [{ severity: 'MEDIUM' }] }));
  STAGES[3].check({ worktree: wt }); // no throw — MEDIUM/LOW don't gate
});

test('push stage opens the PR as a DRAFT — review/test have not run at stage 5', () => {
  const run = { branch: 'b', requirement: 'q', jira_key: null, issue_type: null };
  assert.match(STAGES[4].prompt(run), /--draft/);
  assert.match(STAGES[4].prompt(run), /DRAFT pull request/);
});

test('markerSubdirs finds one-level subdirs with a test marker, skips dotdirs and node_modules', () => {
  const wt = mkdtempSync(join(tmpdir(), 'ms-'));
  mkdirSync(join(wt, 'backend'));
  writeFileSync(join(wt, 'backend', 'pytest.ini'), '');
  mkdirSync(join(wt, 'frontend'));
  writeFileSync(join(wt, 'frontend', 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  mkdirSync(join(wt, 'nomarker'));
  mkdirSync(join(wt, '.git'));
  mkdirSync(join(wt, 'node_modules'));
  assert.deepEqual(markerSubdirs(wt).sort(), ['backend', 'frontend']);
});

test('hasTestSources: root src/test, one-level subdir src/androidTest, or neither', () => {
  const a = mkdtempSync(join(tmpdir(), 'hts-'));
  mkdirSync(join(a, 'src', 'test'), { recursive: true });
  assert.equal(hasTestSources(a), true);
  const b = mkdtempSync(join(tmpdir(), 'hts-'));
  mkdirSync(join(b, 'app', 'src', 'androidTest'), { recursive: true });
  assert.equal(hasTestSources(b), true);
  const c = mkdtempSync(join(tmpdir(), 'hts-'));
  mkdirSync(join(c, 'src', 'main'), { recursive: true });
  assert.equal(hasTestSources(c), false);
});

test('untilStage precedence: --until row > .autodev.json "until" > "push":false > last scheduled stage', () => {
  assert.equal(untilStage({}, 3), 3);
  assert.equal(untilStage({ until: 'analyze' }, null), 2);
  assert.equal(untilStage({ push: false }, null), 4);
  assert.equal(untilStage({}, null), 7);
  assert.equal(untilStage({ deploy: { merge: true } }, null), 8);
});

test('spec-less run: implement and verify work from the requirement, and the commit is the check', () => {
  // Skipping the Spec stage (.autodev.json "skip") left Implement demanding a tasks.md that was
  // never written — run #9 parked on ENOENT specs/066-…/tasks.md after making its change.
  const wt = gitRepo();
  const run = { worktree: wt, requirement: 'SCRUM-75: heading too large', jira_key: 'SCRUM-75' };
  assert.equal(hasSpecSet(run), false);
  assert.match(STAGES[2].prompt(run), /no spec set.*SCRUM-75: heading too large/s);
  assert.doesNotMatch(STAGES[2].prompt(run), /tasks\.md/);
  assert.match(STAGES[3].prompt(run), /no spec set/);
  assert.match(STAGES[3].prompt(run), /verify\.json/);
  // nothing committed yet: the session did nothing
  assert.throws(() => STAGES[2].check(run), /no commit made/);
  writeFileSync(join(wt, 'fix.txt'), 'smaller heading\n');
  assert.throws(() => STAGES[2].check(run), /uncommitted/i);
  git(wt, ['add', '-A'], commit('fix(login): heading from the type scale'));
  STAGES[2].check(run); // no throw
  // a complete spec set appearing later switches both stages back to it
  const d = join(wt, 'specs/001-x'); mkdirSync(d, { recursive: true });
  for (const f of ['spec.md', 'plan.md']) writeFileSync(join(d, f), '# x\n');
  writeFileSync(join(d, 'tasks.md'), '- [x] T001 done\n');
  git(wt, ['add', '-A'], commit('spec'));
  assert.equal(hasSpecSet(run), true);
  assert.match(STAGES[2].prompt(run), /tasks\.md/);
});

/* ---- design references: a picture on the ticket is an acceptance criterion ---- */

function repoWithDesign(files) {
  const wt = gitRepo();
  mkdirSync(join(wt, '.autodev/design'), { recursive: true });
  for (const f of files) writeFileSync(join(wt, '.autodev/design', f), 'x');
  return wt;
}
const stage = (key) => STAGES.find(s => s.key === key);

const score = (wt, screen, body) =>
  writeFileSync(join(wt, '.autodev/design', `score-${screen}.json`), typeof body === 'string' ? body : JSON.stringify(body));

test('design references are listed, and the loop\'s own artifacts are not mistaken for them', () => {
  const wt = repoWithDesign(['card.png', 'flow.JPG', 'compare-card.png', 'render-card.png', 'diff-card.png',
    'brief-card-top.png', 'brief-card.json', 'score-card.json', 'notes.txt']);
  const run = { worktree: wt };
  assert.deepEqual(designRefs(run), ['card.png', 'flow.JPG']);
  assert.deepEqual(designCompares(run), ['compare-card.png']);
  assert.deepEqual(designBriefs(run), ['brief-card.json']);
  assert.deepEqual(designRefs({ worktree: gitRepo() }), [], 'no design directory is not an error');
});

test('the gate wants a score for every compare image, at or under the threshold, and not mostly masked', () => {
  const wt = repoWithDesign(['card.png']);
  const run = { worktree: wt };
  assert.throws(() => designGate(run), /never compared to the built UI/);

  writeFileSync(join(wt, '.autodev/design/compare-card.png'), 'x');
  assert.throws(() => designGate(run), /no \.autodev\/design\/score-card\.json/, 'a side-by-side alone is an opinion');

  score(wt, 'card', 'not json');
  assert.throws(() => designGate(run), /not a score\.py result/);

  score(wt, 'card', { mismatchPct: 24.7, maskedPct: 5 });
  assert.throws(() => designGate(run), /card: 24\.7% of the screen differs .*limit 10%/);

  score(wt, 'card', { mismatchPct: 2, maskedPct: 61 });
  assert.throws(() => designGate(run), /masks 61% of the screen/);

  score(wt, 'card', { mismatchPct: 7.9, maskedPct: 12 });
  designGate(run); // measured, under the limit, honestly masked — the gate opens
  assert.deepEqual(designScores(run).map(s => [s.screen, s.mismatchPct]), [['card', 7.9]]);

  // a second compare image without its own score closes it again
  writeFileSync(join(wt, '.autodev/design/compare-list.png'), 'x');
  assert.throws(() => designGate(run), /score-list\.json/);

  // no references: nothing to demand, whatever else is in the directory
  designGate({ worktree: gitRepo() });
});

test('the threshold comes from .autodev.json "design", with defaults when it says nothing', () => {
  const wt = repoWithDesign(['card.png']);
  writeFileSync(join(wt, '.autodev/design/compare-card.png'), 'x');
  score(wt, 'card', { mismatchPct: 14, maskedPct: 0 });
  const run = { worktree: wt };
  assert.throws(() => designGate(run), /limit 10%/);
  assert.equal(DESIGN_DEFAULTS.maxMismatchPct, 10);
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ design: { maxMismatchPct: 15 } }));
  designGate(run);
  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ design: { maxMismatchPct: 5 } }));
  assert.throws(() => designGate(run), /limit 5%/);
});

test('implement is told how to render and how to score, and the scorer it is told to run is the one the gate reads', () => {
  const wt = repoWithDesign(['card.png']);
  const run = { worktree: wt, requirement: 'SCRUM-9: the card' };
  let prompt = stage('implement').prompt(run);
  assert.match(prompt, /shot\.mjs/, 'no repo command: the skill\'s screenshotter, which fixes viewport and DPR');
  assert.match(prompt, new RegExp(designScript('score.py').replaceAll('\\', '\\\\').replaceAll('.', '\\.')));
  assert.match(prompt, /score-<screen>\.json at or under 10% mismatch/);
  assert.doesNotMatch(prompt, /brief-/, 'no brief on disk, none promised');

  writeFileSync(join(wt, '.autodev.json'), JSON.stringify({ design: { screenshotCmd: 'bash scripts/design-shot.sh', maxMismatchPct: 8 } }));
  writeFileSync(join(wt, '.autodev/design/brief-card.json'), '{}');
  prompt = stage('implement').prompt(run);
  assert.match(prompt, /exactly: `bash scripts\/design-shot\.sh <url-or-path>/);
  assert.match(prompt, /do not build a scratch HTML harness/);
  assert.doesNotMatch(prompt, /shot\.mjs/, 'the repo\'s command replaces the generic one');
  assert.match(prompt, /brief-card\.json/);
  assert.match(prompt, /under 8% mismatch/);
});

test('implement cannot finish a design ticket without the measured match, even when Verify is skipped', () => {
  const wt = repoWithDesign(['card.png']);
  writeFileSync(join(wt, '.gitignore'), '.autodev/\n'); // as every real target repo does
  writeFileSync(join(wt, 'a.txt'), 'x');
  git(wt, ['add', '-A'], commit('the change'));
  const run = { worktree: wt, requirement: 'SCRUM-9: the card' };
  assert.throws(() => stage('implement').check(run), /never compared to the built UI/);
  writeFileSync(join(wt, '.autodev/design/compare-card.png'), 'x');
  score(wt, 'card', { mismatchPct: 3.2, maskedPct: 0 });
  stage('implement').check(run);
});

test('implement is told about the references by name, and told to prove the match', () => {
  const run = { worktree: repoWithDesign(['card.png']), requirement: 'SCRUM-9: the card' };
  const prompt = stage('implement').prompt(run);
  assert.match(prompt, /\.autodev\/design\/: card\.png/);
  assert.match(prompt, /compare-<screen>\.png/);
  assert.match(prompt, /autodev-pixel-match/);
  // a ticket with no picture is left exactly as it was
  assert.doesNotMatch(stage('implement').prompt({ worktree: gitRepo(), requirement: 'x' }), /design/i);
});

test('verify cannot pass a design ticket that was never compared', () => {
  const wt = repoWithDesign(['card.png']);
  const run = { worktree: wt, requirement: 'SCRUM-9: the card' };
  mkdirSync(join(wt, '.autodev'), { recursive: true });
  writeFileSync(join(wt, '.autodev/verify.json'), JSON.stringify({ verdict: 'PASS', findings: [] }));
  assert.throws(() => stage('verify').check(run), /never compared to the built UI/);

  writeFileSync(join(wt, '.autodev/design/compare-card.png'), 'x');
  assert.throws(() => stage('verify').check(run), /score-card\.json/, 'a picture without its number is not evidence');
  score(wt, 'card', { mismatchPct: 4, maskedPct: 0 });
  stage('verify').check(run); // the side-by-side exists and was measured under the limit — the gate opens

  // a run with no references keeps the old behaviour: nothing to compare, nothing to demand
  const plain = gitRepo();
  mkdirSync(join(plain, '.autodev'), { recursive: true });
  writeFileSync(join(plain, '.autodev/verify.json'), JSON.stringify({ verdict: 'PASS', findings: [] }));
  stage('verify').check({ worktree: plain });
});

test('verify names appearance as a criterion only when there are references', () => {
  const p = stage('verify').prompt({ worktree: repoWithDesign(['card.png']), requirement: 'r' });
  assert.match(p, /\(E\) appearance/);
  assert.match(p, /re-score it with `python3 .*score\.py`/);
  assert.doesNotMatch(stage('verify').prompt({ worktree: gitRepo(), requirement: 'r' }), /\(E\) appearance/);
});
