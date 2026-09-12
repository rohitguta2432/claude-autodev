// Proof of shipping: the evidence a run keeps, and the ticket comment derived from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectProof, proofFiles, gatherProof, proofReport, proofAdf, proofDir } from '../src/proof.js';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('collectProof copies the artifacts a stage left and skips the ones it did not', () => {
  const runDir = tmp('run-'), worktree = tmp('wt-');
  mkdirSync(join(worktree, '.autodev'), { recursive: true });
  writeFileSync(join(worktree, '.autodev/verify.json'), '{"verdict":"PASS","findings":[]}');
  writeFileSync(join(worktree, '.autodev/test-output.txt'), 'ok 1\n');
  // no holdout.json, no review.json
  assert.deepEqual(collectProof({ runDir, worktree, stageKey: 'verify' }), ['verify.json']);
  assert.deepEqual(collectProof({ runDir, worktree, stageKey: 'review' }), []);
  assert.deepEqual(collectProof({ runDir, worktree, stageKey: 'test' }), ['test-output.txt']);
  writeFileSync(join(runDir, 'deploy-output.txt'), 'deployed abc123\n');
  assert.deepEqual(collectProof({ runDir, worktree, stageKey: 'deploy' }), ['deploy-output.txt']);
  assert.deepEqual(proofFiles(runDir).map(f => f.name), ['deploy-output.txt', 'test-output.txt', 'verify.json']);
  assert.ok(existsSync(join(proofDir(runDir), 'verify.json')));
  assert.equal(readFileSync(join(proofDir(runDir), 'deploy-output.txt'), 'utf8'), 'deployed abc123\n');
});

test('proofFiles is empty for a run that predates proof collection', () => {
  assert.deepEqual(proofFiles(tmp('run-')), []);
});

const run = { id: 4, issue_ref: 'SCRUM-45', slug: 'x', pr_url: 'https://github.com/o/r/pull/1' };
const ev = (type, detail, stage, extra = {}) => ({ ts: Date.parse('2026-09-03T17:17:00Z'), type, detail, stage, ...extra });

test('the report says what was NOT done: no merge, no deploy, and names the PR', () => {
  const events = [ev('stage_started', 'Spec', 1), ev('activity', 'test command: npm test', 7), ev('stage_done', 'Test', 7)];
  const r = proofReport(run, { events, files: [], verdicts: {} });
  assert.match(r.headline, /run #4 finished SCRUM-45/);
  assert.match(r.headline, /pull request left open, nothing deployed/);
  const by = Object.fromEntries(r.facts.map(f => [f.label, f.link ?? f.text]));
  assert.equal(by['Pull request'], run.pr_url);
  assert.equal(by.Merged, 'not by autodev');
  assert.match(by.Deployed, /^not by autodev/);
  assert.equal(by.Tests, 'npm test exited 0');
  assert.match(by['Evidence attached'], /none collected/);
  assert.equal(r.deployTail, null);
});

test('the report carries the merge commit, the deploy line, verdicts, timing and attachments', () => {
  const t0 = Date.parse('2026-09-03T17:17:00Z');
  const events = [
    { ...ev('stage_started', 'Spec', 1), ts: t0 },
    { ...ev('metrics', undefined, 1), cost_usd: 1.25 },
    ev('activity', 'test command: npm run build', 7),
    ev('merged', 'abcdef123456 via gh pr merge --rebase', 8),
    ev('deployed', 'bash scripts/deploy.sh · exit 0 · 412s', 8),
    { ...ev('stage_done', 'Deploy', 8), ts: t0 + 53 * 60_000 },
  ];
  const verdicts = { review: { verdict: 'APPROVE', findings: [] }, verify: { verdict: 'PASS', findings: [{ id: 'C1' }] } };
  const r = proofReport(run, { events, files: ['prod.png', 'deploy-output.txt'], verdicts, deployTail: 'deployed abcdef1' });
  assert.match(r.headline, /merged and deployed\.$/);
  const by = Object.fromEntries(r.facts.map(f => [f.label, f.link ?? f.text]));
  assert.equal(by.Merged, 'abcdef123456 via gh pr merge --rebase');
  assert.equal(by.Deployed, 'bash scripts/deploy.sh · exit 0 · 412s');
  assert.equal(by.Review, 'APPROVE (0 finding(s))');
  assert.equal(by.Verify, 'PASS (1 finding(s))');
  assert.equal(by['Holdout scenarios'], undefined); // no verdict → no claim
  assert.match(by.Pipeline, /^Spec 17:17 UTC → Deploy 18:10 UTC, 53 min, \$1\.25$/);
  assert.equal(by['Evidence attached'], 'prod.png, deploy-output.txt');

  const adf = proofAdf(r);
  assert.equal(adf.type, 'doc');
  const json = JSON.stringify(adf);
  assert.match(json, /"href":"https:\/\/github.com\/o\/r\/pull\/1"/);
  assert.match(json, /"type":"bulletList"/);
  assert.match(json, /"type":"codeBlock".*deployed abcdef1/);
});

test('gatherProof reads verdicts, events and the deploy tail from the run directory', () => {
  const runDir = tmp('run-');
  mkdirSync(proofDir(runDir));
  writeFileSync(join(proofDir(runDir), 'review.json'), '{"verdict":"APPROVE","findings":[]}');
  writeFileSync(join(proofDir(runDir), 'deploy-output.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
  writeFileSync(join(runDir, 'events.jsonl'), JSON.stringify(ev('deployed', 'x · exit 0 · 1s', 8)) + '\nnot json\n');
  const p = gatherProof(runDir, ['review.json']);
  assert.equal(p.verdicts.review.verdict, 'APPROVE');
  assert.equal(p.verdicts.verify, null);
  assert.deepEqual(p.files, ['review.json']);
  assert.equal(p.events.length, 1); // the malformed line is dropped, not fatal
  assert.equal(p.deployTail.split('\n').length, 15);
  assert.match(p.deployTail, /line 29$/);
});

test('a direct-push run reports the push and the fast-forward instead of a pull request', () => {
  const events = [ev('stage_started', 'Implement', 3), ev('pushed', 'abc123def456 on autodev/009-x, rebased onto origin/main', 5),
    ev('merged', 'abc123def456 via git push origin HEAD:main (fast-forward, pushMode direct)', 8),
    ev('deployed', 'bash scripts/deploy.sh · exit 0 · 90s', 8), ev('stage_done', 'Deploy', 8)];
  const r = proofReport({ ...run, pr_url: null }, { events, files: ['prod.png'], verdicts: {} });
  const by = Object.fromEntries(r.facts.map(f => [f.label, f.link ?? f.text]));
  assert.equal(by['Pull request'], undefined);
  assert.match(by.Pushed, /rebased onto origin\/main/);
  assert.match(by.Merged, /fast-forward/);
  assert.match(r.headline, /merged and deployed\.$/);
});

test('verify collects the design side-by-sides, so the ticket carries the comparison', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  mkdirSync(join(wt, '.autodev/design'), { recursive: true });
  writeFileSync(join(wt, '.autodev/verify.json'), JSON.stringify({ verdict: 'PASS' }));
  writeFileSync(join(wt, '.autodev/design/card.png'), 'the reference');
  writeFileSync(join(wt, '.autodev/design/compare-card.png'), 'side by side');
  writeFileSync(join(wt, '.autodev/design/compare-list.webp'), 'side by side');

  const copied = collectProof({ runDir, worktree: wt, stageKey: 'verify' });
  assert.deepEqual(copied.sort(), ['compare-card.png', 'compare-list.webp', 'verify.json']);
  // the reference itself is not evidence of anything — only the comparison is
  assert.ok(!copied.includes('card.png'));
  // and a stage that is not verify does not sweep them up
  assert.deepEqual(collectProof({ runDir, worktree: wt, stageKey: 'review' }), []);
});
