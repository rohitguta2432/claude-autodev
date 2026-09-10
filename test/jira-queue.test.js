// The Jira queue's reconcile step against a local stub Jira: evidence goes on the ticket
// before the status changes, and a failed upload leaves the ticket open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-jq-'));
const { openDb, createRun, updateRun, runDir } = await import('../src/db.js');
const { tick, dispatchPlan, outcomeFor } = await import('../src/jira-queue.js');

// A Jira that records every request. `failAttach` makes the attachment endpoint 500.
function stubJira({ failAttach = false } = {}) {
  const log = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, type: req.headers['content-type'] ?? '', xsrf: req.headers['x-atlassian-token'], body };
      log.push(entry);
      const reply = (code, json) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(json === undefined ? '' : JSON.stringify(json)); };
      if (req.url.includes('/attachments')) return reply(failAttach ? 500 : 200, failAttach ? { errorMessages: ['nope'] } : [{ id: '1' }]);
      if (req.url.endsWith('/comment')) return reply(201, { id: '9' });
      if (req.url.includes('/transitions') && req.method === 'GET') return reply(200, { transitions: [{ id: '41', to: { statusCategory: { key: 'done' } } }] });
      if (req.url.includes('/transitions')) return reply(204);
      if (req.url.includes('?fields=status')) return reply(200, { fields: { status: { statusCategory: { key: 'indeterminate' } } } });
      if (req.url.includes('/search/jql')) return reply(200, { issues: [] });
      reply(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, base: `http://127.0.0.1:${server.address().port}` })));
}

function finishedRun(repoPath, key) {
  const db = openDb();
  const id = createRun(db, { slug: 'x', repo: 'demo', repo_path: repoPath, worktree: repoPath, branch: 'autodev/001-x',
    requirement: 'demo', issue_ref: key });
  updateRun(db, id, { status: 'DONE', stage: 8, pr_url: 'https://github.com/o/r/pull/1' });
  db.close();
  const dir = runDir(id);
  mkdirSync(join(dir, 'proof'), { recursive: true });
  writeFileSync(join(dir, 'proof', 'prod.png'), 'PNG-BYTES');
  writeFileSync(join(dir, 'proof', 'test-output.txt'), 'ok 1\n');
  writeFileSync(join(dir, 'events.jsonl'), [
    { ts: 1, type: 'stage_started', stage: 1, detail: 'Spec' },
    { ts: 2, type: 'merged', stage: 8, detail: 'abc123def456 via gh pr merge --rebase' },
    { ts: 3, type: 'deployed', stage: 8, detail: 'node deploy.js · exit 0 · 3s' },
    { ts: 4, type: 'stage_done', stage: 8, detail: 'Deploy' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  return id;
}

const configure = (base, repoPath) => writeFileSync(join(process.env.AUTODEV_HOME, 'jira-queue.json'), JSON.stringify({
  enabled: false, baseUrl: base, email: 'e@x', apiToken: 't', project: 'SCRUM', repoPath }));

test('a DONE run closes its ticket with attachments first, then the comment, then the transition', async () => {
  const { server, log, base } = await stubJira();
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  configure(base, repo);
  const id = finishedRun(repo, 'SCRUM-45');
  const out = await tick();
  server.close();
  assert.equal(out.error, null);
  assert.deepEqual(out.reconciled, ['SCRUM-45']);

  const seq = log.filter(e => e.method === 'POST').map(e => e.url.replace(/^.*SCRUM-45\//, ''));
  assert.deepEqual(seq, ['attachments', 'attachments', 'comment', 'transitions']);
  const uploads = log.filter(e => e.url.endsWith('/attachments'));
  for (const u of uploads) { assert.match(u.type, /^multipart\/form-data/); assert.equal(u.xsrf, 'no-check'); }
  assert.match(uploads[0].body, /filename="prod.png"/);
  assert.match(uploads[0].body, /PNG-BYTES/);
  assert.match(uploads[1].body, /filename="test-output.txt"/);

  const comment = JSON.parse(log.find(e => e.url.endsWith('/comment')).body);
  assert.equal(comment.body.type, 'doc');
  const text = JSON.stringify(comment.body);
  assert.match(text, /run #\d+ finished SCRUM-45: built, reviewed, tested, merged and deployed/);
  assert.match(text, /abc123def456 via gh pr merge --rebase/);
  assert.match(text, /node deploy.js · exit 0 · 3s/);
  assert.match(text, /prod.png, test-output.txt/);
  assert.equal(JSON.parse(log.find(e => e.url.endsWith('/transitions') && e.method === 'POST').body).transition.id, '41');

  // announced once: a second tick neither re-attaches nor re-comments
  const { server: s2, log: log2, base: b2 } = await stubJira();
  configure(b2, repo);
  await tick();
  s2.close();
  assert.deepEqual(log2.filter(e => e.method === 'POST'), []);
  void id;
});

test('an upload failure leaves the ticket open: no comment, no transition, retried next tick', async () => {
  const { server, log, base } = await stubJira({ failAttach: true });
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  configure(base, repo);
  finishedRun(repo, 'SCRUM-46');
  const out = await tick();
  server.close();
  assert.match(out.error, /jira attach prod.png → 500/);
  assert.deepEqual(log.filter(e => e.method === 'POST').map(e => e.url.split('/').at(-1)), ['attachments']);
  // still owed: the next tick tries again
  const { server: s2, log: log2, base: b2 } = await stubJira();
  configure(b2, repo);
  const again = await tick();
  s2.close();
  assert.equal(again.error, null);
  assert.deepEqual(log2.filter(e => e.method === 'POST').map(e => e.url.split('/').at(-1)), ['attachments', 'attachments', 'comment', 'transitions']);
});

test('reconcileOnly closes a finished run with dispatch off, and starts nothing', async () => {
  // A run started by hand (`autodev run "SCRUM-75: …"`) is not the queue's, but its ticket is
  // still owed the proof. The server asks for exactly this when a run ends and enabled=false.
  const { server, log, base } = await stubJira();
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  configure(base, repo); // enabled: false
  finishedRun(repo, 'SCRUM-75');
  const out = await tick({ reconcileOnly: true });
  server.close();
  assert.equal(out.error, null);
  assert.deepEqual(out.reconciled, ['SCRUM-75']);
  assert.deepEqual(out.started, []);
  const seq = log.filter(e => e.method === 'POST').map(e => e.url.replace(/^.*SCRUM-75\//, ''));
  assert.deepEqual(seq, ['attachments', 'attachments', 'comment', 'transitions']);
  // and the dispatch side never woke: no story search at all
  assert.equal(log.some(e => e.url.includes('/search/jql')), false);
});

test('outcomeFor: blocked and rejected runs stay open with a plain paragraph', () => {
  const blocked = outcomeFor({ id: 3, status: 'BLOCKED', stage: 7, blocked_reason: 'tests still failing' });
  assert.equal(blocked.done, false);
  assert.match(JSON.stringify(blocked.body), /parked at stage 7: tests still failing/);
  const rejected = outcomeFor({ id: 5, status: 'REJECTED', blocked_reason: 'payments are a non-goal' });
  assert.equal(rejected.done, false);
  assert.match(JSON.stringify(rejected.body), /out of scope/);
  const done = outcomeFor({ id: 6, status: 'DONE', slug: 'x' }, { events: [], files: [] });
  assert.equal(done.done, true);
  assert.match(JSON.stringify(done.body), /pull request left open, nothing deployed/);
});

test('dispatchPlan starts unseen stories oldest first, bounded by free slots', () => {
  const stories = [{ key: 'S-1' }, { key: 'S-2' }, { key: 'S-3' }];
  assert.deepEqual(dispatchPlan({ stories, runs: [{ issue_ref: 'S-1' }], active: 0, maxParallel: 1 }).map(s => s.key), ['S-2']);
  assert.deepEqual(dispatchPlan({ stories, runs: [], active: 1, maxParallel: 1 }), []);
});

test('overlapping ticks collapse into one — a run cannot be announced twice', async () => {
  const { server, log, base } = await stubJira();
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  configure(base, repo);
  finishedRun(repo, 'SCRUM-47');
  const [a, b] = await Promise.all([tick(), tick()]);
  server.close();
  assert.equal(a, b); // same tick, same result object
  assert.equal(log.filter(e => e.url.endsWith('/comment')).length, 1);
});
