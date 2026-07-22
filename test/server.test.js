import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-srv-'));
// jump spawns a real runner — never let it reach the real claude (portable no-op node stub)
const stubDir = mkdtempSync(join(tmpdir(), 'srv-stub-'));
writeFileSync(join(stubDir, 'claude-stub.js'), '');
process.env.AUTODEV_CLAUDE_BIN = join(stubDir, 'claude-stub.js');
const { startServer } = await import('../src/server.js');
const { runDir } = await import('../src/db.js');

const { port, close } = await startServer({ port: 0 });
after(() => close());
const base = `http://127.0.0.1:${port}`;
const j = (r) => r.json();

test('POST /runs registers and GET /api/runs lists', async () => {
  const { id } = await j(await fetch(`${base}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'x', repo: 'demo', repo_path: '/p', worktree: '/w', branch: 'b', requirement: 'q' }),
  }));
  assert.equal(id, 1);
  const runs = await j(await fetch(`${base}/api/runs`));
  assert.equal(runs[0].slug, 'x');
});

test('lifecycle events update run row; detail endpoint merges jsonl', async () => {
  await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run: 1, type: 'stage_started', stage: 3, ts: Date.now() }) });
  await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run: 1, type: 'parked', stage: 5, detail: 'tests keep failing', ts: Date.now() }) });
  mkdirSync(runDir(1), { recursive: true });
  writeFileSync(join(runDir(1), 'events.jsonl'), JSON.stringify({ run: 1, type: 'activity', detail: 'x', ts: 1 }) + '\n');
  const run = await j(await fetch(`${base}/api/runs/1`));
  assert.equal(run.stage, 5);
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.blocked_reason, 'tests keep failing');
  assert.equal(run.events.length, 1);
});

test('malformed JSON body gets an error response, server survives', async () => {
  const res = await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{not valid json' });
  assert.ok(res.status >= 400);
  const alive = await fetch(`${base}/api/runs`);
  assert.equal(alive.status, 200);
});

test('GET /stream is SSE and receives broadcast', async () => {
  const res = await fetch(`${base}/stream`);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run: 1, type: 'task_done', stage: 3, detail: 'T004', ts: Date.now() }) });
  let buffer = '';
  while (!buffer.includes('task_done')) {
    const { value } = await reader.read();
    buffer += new TextDecoder().decode(value);
  }
  assert.match(buffer, /task_done/);
  reader.cancel();
});

test('GET /api/runs/:id serves tasks parsed live from tasks.md', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'wt-tasks-'));
  mkdirSync(join(worktree, 'specs', '001-x'), { recursive: true });
  writeFileSync(join(worktree, 'specs', '001-x', 'tasks.md'),
    '- [x] T001 write tests\n- [X] T002 write more tests\n- [ ] T003 implement feature\n');
  const { id } = await j(await fetch(`${base}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'tasks-run', repo: 'demo', repo_path: '/p', worktree, branch: 'b', requirement: 'q' }),
  }));
  const run = await j(await fetch(`${base}/api/runs/${id}`));
  assert.deepEqual(run.tasks, [
    { id: 'T001', done: true, text: 'write tests', group: '' },
    { id: 'T002', done: true, text: 'write more tests', group: '' },
    { id: 'T003', done: false, text: 'implement feature', group: '' },
  ]);
});

test('POST /api/runs/:id/jump validates, sets stage, and relaunches the runner', async () => {
  assert.equal((await fetch(`${base}/api/runs/999/jump`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"stage":3}' })).status, 404);

  // worktree with no test config → stage 7 detects no test cmd and completes the run
  const worktree = mkdtempSync(join(tmpdir(), 'wt-jump-'));
  const { id } = await j(await fetch(`${base}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'jump', repo: 'demo', repo_path: '/p', worktree, branch: 'b', requirement: 'q' }),
  }));

  assert.equal((await fetch(`${base}/api/runs/${id}/jump`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"stage":9}' })).status, 400);

  const res = await fetch(`${base}/api/runs/${id}/jump`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"stage":7}' });
  assert.equal(res.status, 200);
  let run;
  for (let i = 0; i < 50; i++) { // spawned runner skips tests (none detected) and finishes
    run = await j(await fetch(`${base}/api/runs/${id}`));
    if (run.status === 'DONE') break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(run.status, 'DONE');
  assert.equal(run.stage, 7);

  // completed stages are immutable — no jumping back into history
  const back = await fetch(`${base}/api/runs/${id}/jump`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"stage":3}' });
  assert.equal(back.status, 409);
  assert.match((await j(back)).error, /already completed/);
});

test('POST /api/runs/:id/skip records a pending skip and completes on last-stage skip', async () => {
  assert.equal((await fetch(`${base}/api/runs/999/skip`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"stage":3}' })).status, 404);

  const worktree = mkdtempSync(join(tmpdir(), 'wt-skip-'));
  const { id } = await j(await fetch(`${base}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'skip', repo: 'demo', repo_path: '/p', worktree, branch: 'b', requirement: 'q' }),
  }));

  assert.equal((await fetch(`${base}/api/runs/${id}/skip`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"stage":0}' })).status, 400);

  // skip a future pending stage → recorded, pointer unchanged, no runner spawned
  const res = await fetch(`${base}/api/runs/${id}/skip`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"stage":5}' });
  assert.equal(res.status, 200);
  let run = await j(await fetch(`${base}/api/runs/${id}`));
  assert.equal(run.skipped, '5');
  assert.equal(run.stage, 1); // a future skip must not move the pipeline pointer

  // skipping the current (last) stage advances past the end → run completes, nothing spawned
  const { id: id2 } = await j(await fetch(`${base}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'skip2', repo: 'demo', repo_path: '/p', worktree, branch: 'b', requirement: 'q', stage: 7 }),
  }));
  assert.equal((await fetch(`${base}/api/runs/${id2}/skip`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"stage":7}' })).status, 200);
  run = await j(await fetch(`${base}/api/runs/${id2}`));
  assert.equal(run.status, 'DONE');
  assert.equal(run.skipped, '7');
});

test('cross-origin POSTs are rejected, headerless (CLI) and same-origin POSTs pass', async () => {
  // browser cross-site form POST: foreign Origin, no preflight
  const foreign = await fetch(`${base}/events`, { method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ run: 1, type: 'activity' }) });
  assert.equal(foreign.status, 403);
  const sfs = await fetch(`${base}/api/runs/1/skip`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ stage: 3 }) });
  assert.equal(sfs.status, 403);
  // dashboard's own fetch: same-origin markers pass the guard
  const same = await fetch(`${base}/events`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ run: 1, type: 'activity', stage: 1 }) });
  assert.equal(same.status, 200);
  // CLI/runner: no browser headers at all — trusted local tooling (covered implicitly
  // by every other test in this file, asserted once explicitly here)
  const cli = await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run: 1, type: 'activity', stage: 1 }) });
  assert.equal(cli.status, 200);
});
