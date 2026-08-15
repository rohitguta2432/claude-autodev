import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPlan, outcomeFor, LABELS } from '../src/daemon.js';

const issue = (number, labels = [], createdAt = '2026-01-01') => ({ number, title: `t${number}`, labels, createdAt });

test('dispatch starts accepted issues oldest first, bounded by capacity', () => {
  const issues = [
    issue(3, [LABELS.accepted], '2026-03-01'),
    issue(1, [LABELS.accepted], '2026-01-01'),
    issue(2, [LABELS.accepted], '2026-02-01'),
  ];
  const plan = dispatchPlan({ issues, runs: [], active: 0, maxParallel: 2, autoAccept: false });
  assert.deepEqual(plan.start.map(i => i.number), [1, 2]);
});

test('a run already in flight consumes capacity', () => {
  const issues = [issue(1, [LABELS.accepted]), issue(2, [LABELS.accepted])];
  assert.equal(dispatchPlan({ issues, runs: [], active: 2, maxParallel: 2, autoAccept: false }).start.length, 0);
  assert.equal(dispatchPlan({ issues, runs: [], active: 1, maxParallel: 2, autoAccept: false }).start.length, 1);
});

test('an issue that already has a run is never started twice', () => {
  // the guard that makes the daemon safe to restart mid-tick: the mapping lives in the db,
  // and a DONE run must not re-queue its own issue on the next pass
  const issues = [issue(7, [LABELS.accepted])];
  const runs = [{ id: 4, issue_ref: '7', status: 'DONE' }];
  assert.equal(dispatchPlan({ issues, runs, active: 0, maxParallel: 2, autoAccept: false }).start.length, 0);
});

test('untriaged issues are picked up only with auto-accept', () => {
  const issues = [issue(1), issue(2, [LABELS.rejected]), issue(3, ['bug'])];
  assert.deepEqual(dispatchPlan({ issues, runs: [], active: 0, maxParallel: 2, autoAccept: false }).accept, []);
  const on = dispatchPlan({ issues, runs: [], active: 0, maxParallel: 2, autoAccept: true });
  // #2 already carries an autodev label — a rejected issue must never be re-accepted
  assert.deepEqual(on.accept.map(i => i.number), [1, 3]);
});

test('acceptance is not bounded by capacity — labelling is free, running is not', () => {
  const issues = [issue(1), issue(2), issue(3)];
  const plan = dispatchPlan({ issues, runs: [], active: 2, maxParallel: 2, autoAccept: true });
  assert.equal(plan.start.length, 0);
  assert.equal(plan.accept.length, 3);
});

test('outcome maps a finished run to a label, a comment and whether to close', () => {
  const shipped = outcomeFor({ id: 1, status: 'DONE', pr_url: 'https://x/pr/9' });
  assert.equal(shipped.label, LABELS.shipped);
  assert.equal(shipped.close, true);
  assert.match(shipped.comment, /https:\/\/x\/pr\/9/);

  const rejected = outcomeFor({ id: 2, status: 'REJECTED', blocked_reason: 'payments are a non-goal' });
  assert.equal(rejected.label, LABELS.rejected);
  assert.equal(rejected.close, true);
  assert.match(rejected.comment, /payments are a non-goal/);
  assert.match(rejected.comment, /mission\.md/);

  // a parked run stays open: it is waiting on the operator, not finished
  const blocked = outcomeFor({ id: 3, status: 'BLOCKED', stage: 4, blocked_reason: 'tests still failing' });
  assert.equal(blocked.label, LABELS.blocked);
  assert.equal(blocked.close, false);
  assert.match(blocked.comment, /autodev resume 3/);
});
