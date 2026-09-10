import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, openSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, createRun, getRun, listRuns, updateRun, deleteRun, runDir, PORT, skippedSet } from './db.js';
import { specDirOf, STAGES, scheduledStages } from './stages.js';
import { repoConfig } from './config.js';
import * as jiraQueue from './jira-queue.js';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// Lifecycle event types → run-row side effects.
function applyEvent(db, ev) {
  const f = {};
  if (ev.stage) f.stage = ev.stage;
  if (ev.type === 'parked') { f.status = 'BLOCKED'; f.blocked_reason = ev.detail || ''; }
  if (ev.type === 'resumed') { f.status = 'RUNNING'; f.blocked_reason = null; }
  if (ev.type === 'run_done') f.status = 'DONE';
  if (ev.type === 'pr_opened') f.pr_url = ev.detail;
  if (Object.keys(f).length) updateRun(db, ev.run, f);
}

function lastEvents(id, limit = 200) {
  const p = join(runDir(id), 'events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    .slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Task ticks for the dashboard's Tasks pane — parsed live from tasks.md, no separate event needed.
function tasksFor(run) {
  try {
    const dir = specDirOf(run); // the run's own spec, not whichever is highest-numbered
    if (!dir) return [];
    const lines = readFileSync(join(dir, 'tasks.md'), 'utf8').split('\n');
    const tasks = [];
    let group = ''; // last ## / ### heading — the phase a task falls under (drives the UI's grouped Tasks panel)
    for (const line of lines) {
      const h = line.match(/^#{2,3}\s+(.+?)\s*$/);
      if (h && !/^format\b/i.test(h[1])) { group = h[1]; continue; }
      const m = line.match(/^- \[( |x|X)\] \**(T\d+)\**\s*(.*)/);
      if (m) tasks.push({ id: m[2], done: m[1].toLowerCase() === 'x', text: m[3], group });
    }
    return tasks;
  } catch { return []; }
}

const body = (req) => new Promise((res, rej) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { rej(new Error('bad json')); } });
});

// CSRF guard for mutating endpoints. Browser requests always carry Origin and/or
// Sec-Fetch-Site; the CLI/runner/tests (non-browser fetch) send neither, so requests
// with neither header are trusted local tooling. A cross-origin form POST (text/plain,
// no preflight) from any web page would carry a foreign Origin — reject it, otherwise
// it could spawn a detached runner (claude --dangerously-skip-permissions) in the worktree.
function crossOrigin(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

// DNS-rebinding defense: we only ever serve localhost, so any other Host is an
// attacker-controlled name resolving to 127.0.0.1 — reject before routing.
function badHost(req) {
  const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '');
  return !['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}

// Kill a run's whole process tree — the runner is its own group leader and claude runs
// inside that group, so a bare pid kill would leave claude alive (same logic as CLI stop).
function killRunTree(run) {
  if (!run.pid) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(run.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-run.pid, 'SIGTERM'); }
    catch { try { process.kill(run.pid); } catch {} }
  }
}
const pidAlive = (pid) => { try { return pid ? (process.kill(pid, 0), true) : false; } catch { return false; } };

export async function startServer({ port = PORT(), dbPath } = {}) {
  const db = openDb(dbPath);
  const clients = new Set();
  const broadcast = (ev) => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };
  // audit line for the activity feed — appended to the run's jsonl and streamed live
  const audit = (id, ev) => {
    mkdirSync(runDir(id), { recursive: true });
    appendFileSync(join(runDir(id), 'events.jsonl'), JSON.stringify(ev) + '\n');
    broadcast(ev);
  };
  // Per-session CSRF token: injected into the served index.html, required on
  // browser-marked mutating requests. Local tooling (CLI/runner — no browser
  // headers) is exempt; a foreign page can neither read the token (SOP) nor
  // reach the routes without browser markers.
  const token = randomBytes(16).toString('hex');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (badHost(req)) return json(403, { error: 'bad host' });
      if (req.method === 'POST' && crossOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
      // Browser-marked POSTs (Origin/Sec-Fetch-Site present) must carry the session token.
      if (req.method === 'POST' && (req.headers.origin || req.headers['sec-fetch-site'])
          && req.headers['x-autodev-token'] !== token)
        return json(403, { error: 'missing or stale dashboard token — reload the page' });
      if (req.method === 'POST' && url.pathname === '/runs')
        return json(201, { id: createRun(db, await body(req)) });
      if (req.method === 'POST' && url.pathname === '/events') {
        const ev = { ts: Date.now(), ...await body(req) }; // stamp ts if the poster didn't
        applyEvent(db, ev);
        for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
        // A run that just ended is reconciled onto its ticket now, not at the next interval:
        // the runner is waiting on this response, so the tick runs after it, not in it.
        // Reconcile whenever Jira is reachable, not only when auto-dispatch is on: a run started
        // by hand still owes its ticket the proof. With dispatch off, close but start nothing.
        if (['run_done', 'parked', 'rejected'].includes(ev.type)) {
          const cfg = jiraQueue.loadConfig();
          if (jiraQueue.configComplete(cfg))
            setImmediate(() => jiraQueue.tick({ onEvent: broadcast, reconcileOnly: !cfg.enabled })
              .then(() => jiraQueue.schedule(broadcast)).catch(() => {}));
        }
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/runs') return json(200, listRuns(db));
      // The board's columns: the stages this repo actually schedules. Deploy is opt-in
      // (.autodev.json "deploy"), so a repo without it has a 7-stage pipeline, not 8.
      if (url.pathname === '/api/stages') {
        const repo = url.searchParams.get('repo') || jiraQueue.loadConfig().repoPath || '';
        const cfg = repo ? repoConfig(repo) : {};
        return json(200, { deploy: Boolean(cfg.deploy), repo,
          stages: scheduledStages(cfg).map(s => ({ n: s.n, title: s.title })) });
      }
      // ---- Jira queue (dashboard-driven; see src/jira-queue.js) ----
      if (url.pathname === '/api/jira' && req.method === 'GET') return json(200, jiraQueue.queueStatus());
      if (req.method === 'POST' && url.pathname === '/api/jira/config') {
        jiraQueue.saveConfig(await body(req));
        jiraQueue.schedule(broadcast); // interval/enabled may have changed — re-arm from the new config
        return json(200, jiraQueue.queueStatus());
      }
      if (req.method === 'POST' && url.pathname === '/api/jira/tick') {
        const out = await jiraQueue.tick({ onEvent: broadcast });
        jiraQueue.schedule(broadcast); // a manual poll restarts the countdown
        return json(200, { ...out, status: jiraQueue.queueStatus() });
      }
      if (url.pathname === '/api/jira/stories' && req.method === 'GET') {
        try {
          const cfg = jiraQueue.loadConfig();
          const stories = await jiraQueue.openStories(cfg);
          const rows = db.prepare('SELECT id, status, stage, issue_ref FROM runs WHERE repo_path = ? AND issue_ref IS NOT NULL').all(cfg.repoPath);
          const byKey = new Map(rows.map(r => [String(r.issue_ref), r]));
          return json(200, stories.map(s => ({ ...s, run: byKey.get(s.key) ?? null })));
        } catch (e) { return json(400, { error: String(e.message || e) }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/jira/clear-state') {
        jiraQueue.clearState();
        return json(200, { ok: true });
      }
      // Stop: fell the run's process tree, park the run (same semantics as `autodev stop`).
      const stopM = url.pathname.match(/^\/api\/runs\/(\d+)\/stop$/);
      if (req.method === 'POST' && stopM) {
        const run = getRun(db, Number(stopM[1]));
        if (!run) return json(404, {});
        killRunTree(run);
        updateRun(db, run.id, { status: 'BLOCKED', blocked_reason: 'stopped from dashboard' });
        audit(run.id, { ts: Date.now(), run: run.id, type: 'parked', stage: run.stage, detail: 'stopped from dashboard' });
        return json(200, { ok: true });
      }
      // Clear: stop if alive, then remove the run's worktree, branch, records, and db row.
      const wipeRun = (run) => {
        if (pidAlive(run.pid)) killRunTree(run);
        if (run.worktree) {
          try { execFileSync('git', ['worktree', 'remove', '--force', run.worktree], { cwd: run.repo_path, stdio: 'ignore' }); }
          catch { rmSync(run.worktree, { recursive: true, force: true }); }
        }
        if (run.branch) { try { execFileSync('git', ['branch', '-D', run.branch], { cwd: run.repo_path, stdio: 'ignore' }); } catch {} }
        rmSync(runDir(run.id), { recursive: true, force: true });
        deleteRun(db, run.id);
        broadcast({ ts: Date.now(), run: run.id, type: 'deleted', detail: `run #${run.id} cleared` });
      };
      const delM = url.pathname.match(/^\/api\/runs\/(\d+)\/delete$/);
      if (req.method === 'POST' && delM) {
        const run = getRun(db, Number(delM[1]));
        if (!run) return json(404, {});
        wipeRun(run);
        return json(200, { ok: true });
      }
      // Clear-all: every run goes — the board and the queue's memory reset to factory-empty.
      if (req.method === 'POST' && url.pathname === '/api/runs/clear-all') {
        const all = listRuns(db);
        for (const run of all) wipeRun(run);
        jiraQueue.clearState();
        return json(200, { ok: true, cleared: all.map(r => r.id) });
      }
      // Jump: restart the pipeline at an arbitrary stage (dashboard "JUMP TO <STAGE>").
      const jm = url.pathname.match(/^\/api\/runs\/(\d+)\/jump$/);
      if (req.method === 'POST' && jm) {
        const run = getRun(db, Number(jm[1]));
        if (!run) return json(404, {});
        const { stage } = await body(req);
        if (!(stage >= 1 && stage <= STAGES.length)) return json(400, { error: `stage must be 1-${STAGES.length}` });
        // completed stages are immutable history — only the current or a future stage is jumpable
        if (run.status === 'DONE' || stage < run.stage)
          return json(409, { error: `stage ${stage} already completed — jump only to current or future stages` });
        const alive = run.pid && (() => { try { process.kill(run.pid, 0); return true; } catch { return false; } })();
        if (run.status === 'RUNNING' && alive) return json(409, { error: 'run is active — stop it first (autodev stop ' + run.id + ')' });
        updateRun(db, run.id, { stage, status: 'RUNNING', blocked_reason: null });
        mkdirSync(runDir(run.id), { recursive: true });
        const log = openSync(join(runDir(run.id), 'runner.log'), 'a');
        spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'runner.js'), String(run.id), '--resume'],
          { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
        return json(200, { ok: true, stage });
      }
      // Skip: bypass a stage without running it. Records it as skipped; if it's the current
      // stage, advances the pipeline past it (and any already-skipped stages) and resumes.
      const sk = url.pathname.match(/^\/api\/runs\/(\d+)\/skip$/);
      if (req.method === 'POST' && sk) {
        const run = getRun(db, Number(sk[1]));
        if (!run) return json(404, {});
        const { stage } = await body(req);
        if (!(stage >= 1 && stage <= STAGES.length)) return json(400, { error: `stage must be 1-${STAGES.length}` });
        // completed stages stay locked — you can only skip the current or a pending stage
        if (run.status === 'DONE' || stage < run.stage)
          return json(409, { error: `stage ${stage} already completed — only the current or a pending stage can be skipped` });
        const alive = run.pid && (() => { try { process.kill(run.pid, 0); return true; } catch { return false; } })();
        if (run.status === 'RUNNING' && alive) return json(409, { error: 'run is active — stop it first (autodev stop ' + run.id + ')' });
        const skipped = skippedSet(run); skipped.add(stage);
        const fields = { skipped: [...skipped].sort((a, b) => a - b).join(',') };
        if (stage === run.stage) { // skipping the live/blocked stage → advance to the next un-skipped stage and resume
          // The end of the pipeline is this repo's last scheduled stage, not the last stage
          // that exists: deploy is opt-in, so skipping Test finishes a repo without it.
          const last = scheduledStages(repoConfig(run.repo_path)).at(-1).n;
          let next = stage + 1; while (skipped.has(next)) next++;
          if (next > last) { fields.status = 'DONE'; fields.stage = last; }
          else { fields.stage = next; fields.status = 'RUNNING'; fields.blocked_reason = null; }
        }
        updateRun(db, run.id, fields);
        // audit line for the activity feed — appended + streamed directly, NOT via /events
        // (applyEvent would rewrite stage from the event and undo the advance above)
        const ev = { ts: Date.now(), run: run.id, type: 'skipped', stage, detail: STAGES[stage - 1].title };
        mkdirSync(runDir(run.id), { recursive: true });
        appendFileSync(join(runDir(run.id), 'events.jsonl'), JSON.stringify(ev) + '\n');
        for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (fields.status === 'RUNNING') { // resumed past the skipped current stage — relaunch the runner
          const log = openSync(join(runDir(run.id), 'runner.log'), 'a');
          spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'runner.js'), String(run.id), '--resume'],
            { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
        }
        return json(200, { ok: true, skipped: fields.skipped, stage: fields.stage ?? run.stage });
      }
      const m = url.pathname.match(/^\/api\/runs\/(\d+)$/);
      if (m) {
        const run = getRun(db, Number(m[1]));
        return run ? json(200, { ...run, events: lastEvents(run.id), tasks: tasksFor(run),
          stage_meta: STAGES.map(s => ({ n: s.n, title: s.title, skill: s.skill ?? null })),
          jira_base: process.env.AUTODEV_JIRA_BASE || null }) : json(404, {});
      }
      if (url.pathname === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(':ok\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      // static
      const file = join(PUB, url.pathname === '/' ? 'index.html' : url.pathname);
      if (file.startsWith(PUB) && existsSync(file)) {
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
        if (file.endsWith('index.html')) // hand the session token to our own page only
          return res.end(readFileSync(file, 'utf8')
            .replace('</head>', `<script>window.AUTODEV_TOKEN=${JSON.stringify(token)}</script>\n</head>`));
        return res.end(readFileSync(file));
      }
      json(404, { error: 'not found' });
    } catch (e) { json(500, { error: String(e) }); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  jiraQueue.schedule(broadcast); // arm the Jira queue timer if the saved config enables it
  return { port: server.address().port,
    close: () => { jiraQueue.stopTimer(); for (const c of clients) c.end(); server.close(); db.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer({});
  console.log(`autodev server on http://127.0.0.1:${port}`);
}
