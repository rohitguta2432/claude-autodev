import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, openSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, createRun, getRun, listRuns, updateRun, runDir, PORT, skippedSet } from './db.js';
import { findSpecDir, STAGES } from './stages.js';

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
    const dir = findSpecDir(run.worktree);
    if (!dir) return [];
    const lines = readFileSync(join(dir, 'tasks.md'), 'utf8').split('\n');
    const tasks = [];
    let group = ''; // last ## / ### heading — the phase a task falls under (drives the UI's grouped Tasks panel)
    for (const line of lines) {
      const h = line.match(/^#{2,3}\s+(.+?)\s*$/);
      if (h && !/^format\b/i.test(h[1])) { group = h[1]; continue; }
      const m = line.match(/^- \[( |x|X)\] (T\d+)\s*(.*)/);
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

export async function startServer({ port = PORT(), dbPath } = {}) {
  const db = openDb(dbPath);
  const clients = new Set();
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
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/runs') return json(200, listRuns(db));
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
        spawn('node', [join(dirname(fileURLToPath(import.meta.url)), 'runner.js'), String(run.id), '--resume'],
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
          let next = stage + 1; while (skipped.has(next)) next++;
          if (next > STAGES.length) { fields.status = 'DONE'; fields.stage = STAGES.length; }
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
          spawn('node', [join(dirname(fileURLToPath(import.meta.url)), 'runner.js'), String(run.id), '--resume'],
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
  return { port: server.address().port, close: () => { for (const c of clients) c.end(); server.close(); db.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer({});
  console.log(`autodev server on http://127.0.0.1:${port}`);
}
