// The Jira queue. daemon.js pulls work from GitHub issues; this pulls it from a Jira
// board. Fully dashboard-driven: config, enable/disable, interval, manual tick, and
// clearing all live behind /api/jira endpoints — no CLI surface on purpose.
//
// One tick, same shape as daemon.js:
//   1. reconcile — every Jira-keyed run that finished gets its issue transitioned/commented
//   2. dispatch  — start runs for open stories (oldest first), up to maxParallel
//
// Durable state is the Jira issue's status plus the runs table's issue_ref column; the
// small state file only remembers what was already announced, so a restart never
// re-comments or re-transitions.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTODEV_HOME, openDb, activeRuns, runsForIssues, runDir } from './db.js';
import { proofFiles, gatherProof, proofReport, proofAdf, adfParagraph } from './proof.js';

const CFG_PATH = () => join(AUTODEV_HOME(), 'jira-queue.json');
const STATE_PATH = () => join(AUTODEV_HOME(), 'jira-queue-state.json');
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autodev.js');
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

const readJson = (p, dflt) => { try { return { ...dflt, ...JSON.parse(readFileSync(p, 'utf8')) }; } catch { return { ...dflt }; } };

const CFG_DEFAULTS = {
  enabled: false, intervalMin: 15, maxParallel: 1,
  baseUrl: '', email: '', apiToken: '', project: '', repoPath: '', testCmd: '',
  // Stage numbers every new run starts with already skipped — set per stage from the board.
  skipStages: [],
};
export function loadConfig() {
  const cfg = readJson(CFG_PATH(), CFG_DEFAULTS);
  // env fills any blank credential/site field so a shell-profile setup needs no UI paste
  cfg.baseUrl ||= process.env.JIRA_BASE_URL || '';
  cfg.email ||= process.env.JIRA_EMAIL || '';
  cfg.apiToken ||= process.env.JIRA_API_TOKEN || '';
  return cfg;
}
export function saveConfig(patch) {
  const onDisk = readJson(CFG_PATH(), CFG_DEFAULTS);
  const next = { ...onDisk };
  for (const k of Object.keys(CFG_DEFAULTS)) {
    if (!(k in patch)) continue;
    // an empty apiToken in the form means "keep what I have", not "wipe the token"
    if (k === 'apiToken' && patch[k] === '') continue;
    next[k] = patch[k];
  }
  // Floor is 15s (0.25m), not 1m — a whole-minute poll leaves fresh tickets idling
  // visibly; Jira's search API is comfortably within rate limits at four polls a minute.
  next.intervalMin = Math.max(0.25, Number(next.intervalMin) || 15);
  next.maxParallel = Math.max(1, Number(next.maxParallel) || 1);
  next.skipStages = [...new Set((next.skipStages || []).map(Number).filter(n => n >= 1 && n <= 8))].sort((a, b) => a - b);
  mkdirSync(AUTODEV_HOME(), { recursive: true });
  writeFileSync(CFG_PATH(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return loadConfig();
}

const STATE_DEFAULTS = { lastTick: 0, notified: {}, log: [] };
const loadState = () => readJson(STATE_PATH(), STATE_DEFAULTS);
function saveState(st) {
  st.log = st.log.slice(-50);
  writeFileSync(STATE_PATH(), JSON.stringify(st), { mode: 0o600 });
}
export function clearState() { saveState({ ...STATE_DEFAULTS }); }

// ---- Jira REST (Basic auth, fetch) ----
async function jira(cfg, method, path, body) {
  const res = await fetch(cfg.baseUrl + path, {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64'),
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`jira ${method} ${path} → ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

// Atlassian document format is a tree; the requirement only needs its plain text.
function adfText(node) {
  if (!node || typeof node !== 'object') return '';
  return [node.text || '', ...(node.content || []).map(adfText)].join('');
}
// Jira's attachment endpoint is the one multipart call the queue makes. Node 22's FormData and
// Blob are stdlib, so no dependency. The XSRF header is what Jira requires on it.
const MAX_ATTACHMENT = 10 * 1024 * 1024; // Jira's default per-file ceiling
async function jiraUpload(cfg, key, file) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(file.path)]), file.name);
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${key}/attachments`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: {
      authorization: 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64'),
      accept: 'application/json',
      'X-Atlassian-Token': 'no-check',
    },
    body: form,
  });
  if (!res.ok) throw new Error(`jira attach ${file.name} → ${res.status} ${(await res.text()).slice(0, 160)}`);
}

// Attach every proof file the run left behind; the names attached come back for the comment.
// Throws on the first failure so the caller neither comments nor transitions on partial
// evidence — the tick fails, and the next one tries again.
export async function attachProof(cfg, key, dir, log = () => {}) {
  const attached = [];
  for (const f of proofFiles(dir)) {
    if (f.size > MAX_ATTACHMENT) { log(`${key}: skipped ${f.name} (${Math.round(f.size / 1048576)} MiB > 10 MiB)`); continue; }
    await jiraUpload(cfg, key, f);
    attached.push(f.name);
  }
  return attached;
}

export async function openStories(cfg) {
  const jql = `project=${cfg.project} AND statusCategory != Done ORDER BY created ASC`;
  const d = await jira(cfg, 'GET',
    `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description,status,issuetype&maxResults=50`);
  return (d.issues || []).map(i => ({
    key: i.key,
    summary: i.fields.summary || '',
    description: adfText(i.fields.description).trim(),
    status: i.fields.status?.name || '',
    type: i.fields.issuetype?.name || '',
  }));
}

// Move an issue into a status CATEGORY (Jira's three: new, indeterminate, done) via the
// first transition that lands there — the category is stable across boards, the status
// names are not. Idempotent: an issue already in the category is left alone.
async function transitionTo(cfg, key, category) {
  const issue = await jira(cfg, 'GET', `/rest/api/3/issue/${key}?fields=status`);
  if (issue.fields.status?.statusCategory?.key === category) return false;
  const d = await jira(cfg, 'GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (d.transitions || []).find(x => x.to?.statusCategory?.key === category);
  if (!t) throw new Error(`no ${category}-category transition on ${key}`);
  await jira(cfg, 'POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
  return true;
}
const transitionDone = (cfg, key) => transitionTo(cfg, key, 'done');

const terminal = (s) => s === 'DONE' || s === 'BLOCKED' || s === 'REJECTED';

// What a finished run means for its Jira issue — pure over the run row and its proof (events,
// attached file names, verdicts, deploy tail; see proof.js gatherProof). `body` is ADF. A DONE
// run's comment is the runner's own record — PR, merge commit, deploy, tests, verdicts,
// attachments — and says outright when nothing was deployed. The sentence a run could earn
// without deploying anything is gone.
export function outcomeFor(run, proof = {}) {
  if (run.status === 'DONE') return { done: true, body: proofAdf(proofReport(run, proof)) };
  if (run.status === 'REJECTED') return { done: false,
    body: adfParagraph(`autodev run #${run.id} rejected this as out of scope.\n${run.blocked_reason || 'no reason recorded'}`) };
  return { done: false,
    body: adfParagraph(`autodev run #${run.id} parked at stage ${run.stage}: ${run.blocked_reason || 'no reason recorded'}. Resume it from the dashboard.`) };
}

// Which stories to start, given what is open and what already ran. Pure and testable.
export function dispatchPlan({ stories, runs, active, maxParallel }) {
  const seen = new Set(runs.map(r => String(r.issue_ref)));
  return stories.filter(s => !seen.has(s.key)).slice(0, Math.max(0, maxParallel - active));
}

function spawnRun(cfg, story, log) {
  const req = `${story.key}: ${story.summary}${story.description ? `\n\n${story.description.slice(0, 4000)}` : ''}`;
  const args = [CLI, 'run', req, '--repo', cfg.repoPath, '--issue-ref', story.key];
  if (cfg.testCmd) args.push('--test-cmd', cfg.testCmd);
  if (cfg.skipStages?.length) args.push('--skip', cfg.skipStages.join(','));
  const out = openSync(join(AUTODEV_HOME(), 'jira-queue-kickoff.log'), 'a');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env: process.env, windowsHide: true });
  child.on('exit', (code) => { if (code) log(`kickoff for ${story.key} exited ${code} — see jira-queue-kickoff.log`); });
  child.unref();
}

// One tick at a time: the interval timer, a dashboard poll and a run's own finish can all ask
// for one, and two reconciles reading the same state file would announce a run twice.
let inFlight = null;
export function tick(opts) {
  if (inFlight) return inFlight;
  inFlight = tickOnce(opts).finally(() => { inFlight = null; });
  return inFlight;
}

// Whether the queue can talk to Jira at all — the same five fields tickOnce refuses without.
// Exported so the server can reconcile a finished run whenever Jira is reachable, not only
// when the dispatch side is switched on.
export const configComplete = (cfg) =>
  Boolean(cfg.baseUrl && cfg.email && cfg.apiToken && cfg.project && cfg.repoPath);

// reconcileOnly: close finished runs onto their tickets but start nothing new. Dispatch
// (pulling open stories into runs) is what "enabled" governs; reconcile is owed to any run
// that already exists, including one started by hand with `autodev run`.
async function tickOnce({ onEvent, reconcileOnly = false } = {}) {
  const cfg = loadConfig();
  const st = loadState();
  const log = (msg) => {
    st.log.push({ ts: Date.now(), msg });
    onEvent?.({ ts: Date.now(), type: 'jira', detail: msg });
  };
  const result = { reconciled: [], started: [], error: null };
  try {
    if (!configComplete(cfg))
      throw new Error('incomplete config — set site, email, token, project and repo');

    const db = openDb();
    const runs = runsForIssues(db, cfg.repoPath).filter(r => JIRA_KEY_RE.test(String(r.issue_ref)));
    const active = activeRuns(db, cfg.repoPath).length;
    db.close();

    // 1. reconcile — announce each terminal run's outcome exactly once. For a finished run the
    //    order is attach → comment → transition: the evidence is on the ticket before the
    //    status changes, and an upload failure leaves the ticket open for the next tick.
    // 0. a run that is working moves its ticket to In Progress, once. Before this the
    //    board showed nothing for the whole run — a ticket went To Do → Done in one jump,
    //    and whoever watched the board could not tell a queued ticket from one being built.
    //    Category-based (indeterminate), so it survives a renamed column; a failure is
    //    logged and retried next tick, never a reason to stop closing finished runs.
    for (const run of runs) {
      if (run.status !== 'RUNNING' || st.notified[run.id]) continue;
      const key = String(run.issue_ref);
      try {
        const moved = await transitionTo(cfg, key, 'indeterminate');
        if (moved) log(`${key} → In Progress (run #${run.id})`);
        st.notified[run.id] = 'RUNNING';
      } catch (e) { log(`${key}: could not mark In Progress — ${String(e.message || e).slice(0, 120)}`); }
    }
    // 1. reconcile — announce each terminal run's outcome exactly once.
    for (const run of runs) {
      if (!terminal(run.status)) continue;
      if (st.notified[run.id] === run.status) continue;
      const key = String(run.issue_ref);
      if (run.status === 'DONE') {
        const dir = runDir(run.id);
        const attached = await attachProof(cfg, key, dir, log);
        const { body } = outcomeFor(run, gatherProof(dir, attached));
        await jira(cfg, 'POST', `/rest/api/3/issue/${key}/comment`, { body });
        await transitionDone(cfg, key);
        log(`${key} → Done with ${attached.length} attachment(s) (run #${run.id})`);
      } else {
        const { body } = outcomeFor(run);
        await jira(cfg, 'POST', `/rest/api/3/issue/${key}/comment`, { body });
        log(`${key} ${run.status.toLowerCase()} (run #${run.id})`);
      }
      st.notified[run.id] = run.status;
      result.reconciled.push(key);
    }

    // 2. dispatch — oldest open story first, one kickoff per free slot
    if (reconcileOnly) {
      if (!result.reconciled.length) log(`reconcile only — nothing finished, ${active} running`);
      st.lastTick = Date.now();
      saveState(st);
      return result;
    }
    const stories = await openStories(cfg);
    for (const story of dispatchPlan({ stories, runs, active, maxParallel: cfg.maxParallel })) {
      spawnRun(cfg, story, log);
      log(`run started for ${story.key}: ${story.summary}`);
      result.started.push(story.key);
    }
    if (!result.started.length && !result.reconciled.length)
      log(`idle — ${active} running, ${stories.length} open stor${stories.length === 1 ? 'y' : 'ies'}`);
  } catch (e) {
    result.error = String(e.message || e);
    log(`tick failed: ${result.error}`);
  }
  st.lastTick = Date.now();
  saveState(st);
  return result;
}

// ---- in-server timer ----
let timer = null, nextTick = 0;
export function schedule(onEvent) {
  if (timer) { clearTimeout(timer); timer = null; }
  const cfg = loadConfig();
  nextTick = 0;
  if (!cfg.enabled) return;
  nextTick = Date.now() + cfg.intervalMin * 60_000;
  timer = setTimeout(async () => { await tick({ onEvent }); schedule(onEvent); }, cfg.intervalMin * 60_000);
  timer.unref?.(); // the queue must never hold the server process open on close
}
export const queueStatus = () => {
  const cfg = loadConfig();
  const st = loadState();
  return {
    enabled: cfg.enabled, intervalMin: cfg.intervalMin, maxParallel: cfg.maxParallel,
    baseUrl: cfg.baseUrl, email: cfg.email, project: cfg.project, repoPath: cfg.repoPath,
    testCmd: cfg.testCmd, skipStages: cfg.skipStages || [], hasToken: Boolean(cfg.apiToken),
    tokenFromEnv: !readJson(CFG_PATH(), CFG_DEFAULTS).apiToken && Boolean(process.env.JIRA_API_TOKEN),
    lastTick: st.lastTick, nextTick, log: st.log.slice(-12),
  };
};
export function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } nextTick = 0; }
