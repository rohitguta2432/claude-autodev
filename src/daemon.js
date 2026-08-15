// The queue. Without it autodev builds whatever you type; with it the repository pulls its
// own work from GitHub issues and keeps pulling while you are asleep.
//
// One tick, in priority order:
//   1. reconcile — every issue whose run has finished gets its label and a comment
//   2. dispatch  — start runs for `autodev:accepted` issues, up to --max-parallel
//   3. accept    — (only with --auto-accept) label untriaged issues so 2 can pick them up
//
// State lives in exactly two places, both durable: the issue's labels, and the runs table's
// issue_ref column. The daemon holds nothing in memory that a restart would lose, so it can
// be killed mid-tick and resume correctly.
import { execFileSync, spawn } from 'node:child_process';
import { openDb, activeRuns, runsForIssues } from './db.js';

export const LABELS = {
  accepted: 'autodev:accepted',
  inProgress: 'autodev:in-progress',
  rejected: 'autodev:rejected',
  blocked: 'autodev:blocked',
  shipped: 'autodev:shipped',
};
const ALL = Object.values(LABELS);

const gh = (cwd, args) => execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000 });

// gh exits non-zero for "no such label" as readily as for "no network"; a tick must survive
// the first and report the second, and neither is worth stopping the daemon for.
function ghSafe(cwd, args, log) {
  try { return gh(cwd, args); }
  catch (e) { log?.(`gh ${args[0]} ${args[1] ?? ''} failed: ${String(e.stderr || e.message).trim().split('\n').at(-1)}`); return null; }
}

export function openIssues(repoPath, log) {
  const out = ghSafe(repoPath, ['issue', 'list', '--state', 'open', '--limit', '100',
    '--json', 'number,title,labels,createdAt'], log);
  if (!out) return [];
  try { return JSON.parse(out).map(i => ({ ...i, labels: i.labels.map(l => l.name) })); }
  catch { return []; }
}

// One issue as a requirement: title first so the branch slug reads well, body kept because
// that is where the actual requirement usually lives.
export function fetchGhIssue(repoPath, number) {
  const out = gh(repoPath, ['issue', 'view', String(number), '--json', 'number,title,body']);
  const { title, body } = JSON.parse(out);
  return { title, requirement: body?.trim() ? `${title}\n\n${body.trim()}` : title };
}

// Create the labels once so `gh issue edit --add-label` cannot fail on a fresh repo.
export function ensureLabels(repoPath, log) {
  for (const name of ALL) {
    ghSafe(repoPath, ['label', 'create', name, '--color', 'ededed',
      '--description', 'managed by autodev', '--force'], log);
  }
}

function setLabel(repoPath, number, label, log) {
  const others = ALL.filter(l => l !== label);
  ghSafe(repoPath, ['issue', 'edit', String(number), '--add-label', label,
    ...others.flatMap(l => ['--remove-label', l])], log);
}

const terminal = (status) => status === 'DONE' || status === 'BLOCKED' || status === 'REJECTED';

// A run's outcome → the label and comment the issue should carry. Pure, so the decision is
// testable without a GitHub remote anywhere in sight.
export function outcomeFor(run) {
  if (run.status === 'DONE') {
    return { label: LABELS.shipped, close: true,
      comment: `autodev run #${run.id} shipped this.${run.pr_url ? `\n\n${run.pr_url}` : ''}` };
  }
  if (run.status === 'REJECTED') {
    return { label: LABELS.rejected, close: true,
      comment: `autodev run #${run.id} rejected this as out of scope.\n\n> ${run.blocked_reason ?? 'no reason recorded'}\n\nEdit \`.autodev/mission.md\` or narrow the issue to change that.` };
  }
  return { label: LABELS.blocked, close: false,
    comment: `autodev run #${run.id} parked at stage ${run.stage}.\n\n> ${run.blocked_reason ?? 'no reason recorded'}\n\nFix the cause and \`autodev resume ${run.id}\`.` };
}

// Which issues this tick should start runs for, given what is open and what has already run.
// Separated from the doing so the scheduling rule can be tested directly: an issue is
// eligible only when it is accepted, has no run of its own yet, and there is capacity.
export function dispatchPlan({ issues, runs, active, maxParallel, autoAccept }) {
  const seen = new Set(runs.map(r => String(r.issue_ref)));
  const capacity = Math.max(0, maxParallel - active);
  const accepted = issues
    .filter(i => i.labels.includes(LABELS.accepted) && !seen.has(String(i.number)))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const untriaged = autoAccept
    ? issues.filter(i => !i.labels.some(l => ALL.includes(l)) && !seen.has(String(i.number)))
    : [];
  return { start: accepted.slice(0, capacity), accept: untriaged, capacity };
}

export function tick(opts) {
  const { repoPath, maxParallel = 2, autoAccept = false, log = console.log, spawnRun } = opts;
  const db = openDb();
  const runs = runsForIssues(db, repoPath);
  const active = activeRuns(db, repoPath).length;
  db.close();

  const issues = openIssues(repoPath, log);
  if (!issues.length && !runs.length) { log('nothing open'); return { started: [], reconciled: [] }; }

  // 1. reconcile — a finished run's issue must stop looking in-progress before anything else
  // happens, or the next tick reports a queue longer than it really is.
  const reconciled = [];
  const byNumber = new Map(issues.map(i => [String(i.number), i]));
  for (const run of runs) {
    if (!terminal(run.status)) continue;
    const issue = byNumber.get(String(run.issue_ref));
    if (!issue) continue; // already closed by hand, or belongs to another repo's board
    const { label, close, comment } = outcomeFor(run);
    if (issue.labels.includes(label)) continue; // already reconciled on an earlier tick
    setLabel(repoPath, issue.number, label, log);
    ghSafe(repoPath, ['issue', 'comment', String(issue.number), '--body', comment], log);
    if (close) ghSafe(repoPath, ['issue', 'close', String(issue.number)], log);
    log(`#${issue.number} → ${label} (run ${run.id} ${run.status})`);
    reconciled.push(issue.number);
  }

  // 2. dispatch
  const plan = dispatchPlan({ issues, runs, active, maxParallel, autoAccept });
  const started = [];
  for (const issue of plan.start) {
    setLabel(repoPath, issue.number, LABELS.inProgress, log);
    spawnRun(issue.number);
    log(`#${issue.number} → run started (${issue.title})`);
    started.push(issue.number);
  }

  // 3. accept — last, so a full queue never grows itself. Note this only labels: the scope
  // decision still belongs to the spec stage reading .autodev/mission.md, which is the only
  // place in the system that knows what this repo is for.
  for (const issue of plan.accept) {
    setLabel(repoPath, issue.number, LABELS.accepted, log);
    log(`#${issue.number} → accepted (${issue.title})`);
  }

  if (!started.length && !reconciled.length && !plan.accept.length)
    log(`idle — ${active}/${maxParallel} running, ${issues.length} open issue(s)`);
  return { started, reconciled, accepted: plan.accept.map(i => i.number) };
}

export async function daemon({ repoPath, intervalMin = 30, maxParallel = 2, autoAccept = false,
                              once = false, cliPath, log = console.log }) {
  ensureLabels(repoPath, log);
  const spawnRun = (number) => {
    // Detached: the daemon must not die with a run, nor a run with the daemon.
    spawn(process.execPath, [cliPath, 'run', '--repo', repoPath, '--issue', String(number)],
      { detached: true, stdio: 'ignore', env: process.env }).unref();
  };
  log(`autodev daemon — repo ${repoPath}, every ${intervalMin}m, up to ${maxParallel} run(s) in parallel${autoAccept ? ', auto-accepting new issues' : ''}`);
  for (;;) {
    try { tick({ repoPath, maxParallel, autoAccept, log, spawnRun }); }
    catch (e) { log(`tick failed: ${e.message}`); } // a bad tick costs one interval, not the daemon
    if (once) return;
    await new Promise(r => setTimeout(r, intervalMin * 60_000));
  }
}
