// Proof of shipping. Every gate in the pipeline is an artifact the runner observed (verdict
// files, a test command's output, a deploy command's output); this module keeps those
// artifacts under runs/<id>/proof/ and turns them, plus the run's own event log, into the
// evidence that closes the originating ticket. Nothing here is a claim a session made — the
// facts come from events the runner wrote and files the runner copied.
import { readFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { HOLDOUT_VERDICT } from './guidance.js';

export const proofDir = (runDir) => join(runDir, 'proof');

// Artifacts a stage leaves in the worktree, and the name each is kept under in proof/.
// Deploy output already lives in the run directory, so its path is absolute.
const STAGE_ARTIFACTS = (runDir) => ({
  verify: [['.autodev/verify.json', 'verify.json']],
  review: [['.autodev/review.json', 'review.json']],
  test: [['.autodev/test-output.txt', 'test-output.txt'], [HOLDOUT_VERDICT, 'holdout.json']],
  deploy: [[join(runDir, 'deploy-output.txt'), 'deploy-output.txt']],
});

// The side-by-sides a design ticket produced, with the score each was gated on and the heat
// map that says where the difference is. Named by the session rather than by us, so they are
// discovered instead of listed — and they are the one artifact a person reading the ticket
// can judge without opening the app. Swept at every stage, not just Verify: a repo that skips
// Verify still produces them in Implement, and gating on one stage meant a design ticket closed
// with prod screenshots but no comparison — the one thing it was raised about.
const designCompareFiles = (worktree) => {
  try {
    return readdirSync(join(worktree, '.autodev/design'))
      .filter(f => /^(compare|diff)-.*\.(png|jpe?g|webp)$/i.test(f) || /^score-.*\.json$/i.test(f)).sort()
      .map(f => [join('.autodev/design', f), f]);
  } catch { return []; }
};

// Copy what a stage produced into proof/. A missing artifact is skipped, never invented:
// the Jira comment later says what was collected, and only that.
export function collectProof({ runDir, worktree, stageKey }) {
  const copied = [];
  const artifacts = [...(STAGE_ARTIFACTS(runDir)[stageKey] ?? []), ...designCompareFiles(worktree)];
  for (const [src, name] of artifacts) {
    const from = isAbsolute(src) ? src : join(worktree, src);
    if (!existsSync(from)) continue;
    mkdirSync(proofDir(runDir), { recursive: true });
    copyFileSync(from, join(proofDir(runDir), name));
    copied.push(name);
  }
  return copied;
}

// Every file in proof/, sorted by name: [{ name, path, size }].
export function proofFiles(runDir) {
  const dir = proofDir(runDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => statSync(join(dir, f)).isFile()).sort()
    .map(name => ({ name, path: join(dir, name), size: statSync(join(dir, name)).size }));
}

export function readEvents(runDir) {
  try {
    return readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const tail = (p, n) => { try { return readFileSync(p, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return null; } };

// Everything the ticket comment is built from, read once from the run directory.
export function gatherProof(runDir, attached = null) {
  const files = proofFiles(runDir);
  const dir = proofDir(runDir);
  return {
    events: readEvents(runDir),
    files: attached ?? files.map(f => f.name),
    verdicts: {
      verify: readJson(join(dir, 'verify.json')),
      review: readJson(join(dir, 'review.json')),
      holdout: readJson(join(dir, 'holdout.json')),
    },
    deployTail: tail(join(dir, 'deploy-output.txt'), 15),
  };
}

// ---- the report: pure over (run, proof) so it is testable without a run directory ----

const hhmm = (ts) => new Date(ts).toISOString().slice(11, 16) + ' UTC';

export function proofReport(run, { events = [], files = [], verdicts = {}, deployTail = null } = {}) {
  const last = (type) => events.filter(e => e.type === type).at(-1) ?? null;
  const merged = last('merged')?.detail ?? null;
  const deployed = last('deployed')?.detail ?? null;
  const testCmd = events.find(e => e.type === 'activity' && /^test command: /.test(e.detail ?? ''))
    ?.detail.slice('test command: '.length) ?? null;
  const testGreen = events.some(e => e.type === 'stage_done' && e.detail === 'Test');
  const starts = events.filter(e => e.type === 'stage_started');
  const ends = events.filter(e => e.type === 'stage_done');
  const cost = events.filter(e => e.type === 'metrics').reduce((s, e) => s + (e.cost_usd ?? 0), 0);

  const shipped = deployed ? 'built, reviewed, tested, merged and deployed'
    : merged ? 'built, reviewed, tested and merged — not deployed by autodev'
      : 'built, reviewed and tested — pull request left open, nothing deployed';
  const headline = `autodev run #${run.id} finished ${run.issue_ref ?? run.jira_key ?? run.slug}: ${shipped}.`;

  const facts = [];
  // pushMode direct opens no pull request; the branch push and the fast-forward onto the
  // base branch are the facts instead, both from events the runner wrote.
  const pushed = last('pushed')?.detail ?? null;
  if (run.pr_url) facts.push({ label: 'Pull request', link: run.pr_url });
  else if (pushed) facts.push({ label: 'Pushed', text: pushed });
  else facts.push({ label: 'Pull request', text: 'none opened (push stage skipped)' });
  facts.push({ label: 'Merged', text: merged ?? 'not by autodev' });
  facts.push({ label: 'Deployed', text: deployed ?? 'not by autodev — the repo has no deploy stage configured' });
  facts.push({ label: 'Tests', text: testCmd ? `${testCmd} exited 0` : testGreen ? 'test stage passed' : 'test stage did not complete' });
  for (const [k, title] of [['review', 'Review'], ['verify', 'Verify'], ['holdout', 'Holdout scenarios']]) {
    const v = verdicts[k];
    if (v?.verdict) facts.push({ label: title, text: `${v.verdict} (${(v.findings ?? []).length} finding(s))` });
  }
  if (starts.length && ends.length) {
    const mins = Math.max(1, Math.round((ends.at(-1).ts - starts[0].ts) / 60_000));
    facts.push({ label: 'Pipeline', text: `${starts[0].detail} ${hhmm(starts[0].ts)} → ${ends.at(-1).detail} ${hhmm(ends.at(-1).ts)}, ${mins} min${cost ? `, $${cost.toFixed(2)}` : ''}` });
  }
  facts.push({ label: 'Evidence attached', text: files.length ? files.join(', ') : 'none collected (run predates proof collection)' });
  return { headline, facts, deployTail };
}

// ---- Atlassian document format ----
const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...content) => ({ type: 'paragraph', content });
const link = (url) => text(url, [{ type: 'link', attrs: { href: url } }]);
export const adfDoc = (...content) => ({ type: 'doc', version: 1, content });
export const adfParagraph = (t) => adfDoc(para(text(t)));

export function proofAdf(report) {
  const items = report.facts.map(f => ({ type: 'listItem', content: [para(
    text(`${f.label}: `, [{ type: 'strong' }]), f.link ? link(f.link) : text(f.text))] }));
  const blocks = [para(text(report.headline, [{ type: 'strong' }])), { type: 'bulletList', content: items }];
  if (report.deployTail) blocks.push(para(text('Deploy output (tail):')), { type: 'codeBlock', content: [text(report.deployTail)] });
  return adfDoc(...blocks);
}
