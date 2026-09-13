// Pure helpers for one headless claude session's failure: what to say about it, whether it
// can ever succeed, and what to record. No I/O and no state — they live in a module only
// because src/runner.js is a top-level script (it reads argv and starts the pipeline on
// import), so nothing in it can be imported by a test.
// Contracts: specs/001-first-green-run/contracts/{park-reason,session-log,terminal-conditions}.md

const MAX_REASON = 300;
const KEEP = 1024 * 1024;      // retained per channel in a session block
const HEAD = 200 * 1024;       // …of which this much is the head; the rest is the tail

// A `--output-format json` result line is one 1.5 KB JSON object whose only human-readable
// part is `result`. Reported whole, it becomes the park reason, blocked.md and the Jira
// comment (run #9: a wall of usage counters where "OAuth session expired" should have been).
function resultText(line) {
  if (!/^\s*\{.*"type":"result"/.test(line)) return line;
  try { const r = JSON.parse(line); return r.type === 'result' ? String(r.result ?? '') : line; }
  catch { return line; }
}

// The last lines of a session's output that actually carry information.
// The tail is where the cause lives, but the very last line is often a rule, a spinner
// remnant or a blank — so lines without a letter or digit are skipped rather than reported.
export function causeLine(text, max = MAX_REASON) {
  const lines = String(text ?? '').split('\n')
    .map(resultText)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l && /[\p{L}\p{N}]/u.test(l));
  return lines.slice(-3).join(' / ').slice(0, max);
}

// The enumerated terminal conditions — failures no retry can fix. Each carries its remedy,
// because a reason that names only the symptom sends the operator hunting.
// Deliberately NOT here: rate limiting. That is exactly what retries exist for, and folding
// it in would turn a recoverable failure into a park.
const TERMINAL = [
  {
    code: 'not-authenticated',
    match: /\bnot logged in\b|please run \/login|invalid api key|authentication_error|\boauth (token|session) (has )?expired\b|failed to authenticate/i,
    reason: 'the claude CLI is installed but not signed in',
    fix: 'run `claude` once interactively to sign in, then `autodev resume <id>`',
  },
  {
    code: 'usage-exhausted',
    // The CLI says "You've hit your weekly limit · resets 9:30pm (Asia/Calcutta)". The first
    // cut of this pattern was written against "usage limit reached" and "exceeded your …
    // limit" and matched neither of those words, so the real message fell through to the
    // ordinary retry path: run #567 bought three identical sessions in 18 seconds against an
    // allowance that reset four minutes later, spent the stage's whole retry budget, and
    // parked anyway. "hit your … limit" is the wording that actually arrives.
    match: /\blimit reached\b|(exceeded|hit) your .{0,40}\blimit\b|\b(weekly|daily|monthly|\d+-hour) limit\b|credit balance is too low|insufficient (credits|quota)/i,
    reason: 'the Claude usage allowance for this account is exhausted',
    fix: 'wait for the allowance to reset or raise it, then `autodev resume <id>`',
  },
];

// → { code, reason, fix } for a terminal condition, or null to keep the normal retry path.
// Order is fixed so a session matching more than one classifies deterministically.
// The caller MUST only pass a session that actually failed: a model quoting "Not logged in"
// while reasoning about an error must never park a run.
export function classify({ code, out } = {}) {
  // Structural first — a binary that could not be launched cannot be confused with content.
  if (code === 'ENOENT') {
    return { code: 'claude-not-found', reason: 'the claude CLI could not be launched',
      fix: 'install the Claude Code CLI, or point AUTODEV_CLAUDE_BIN at it' };
  }
  const text = String(out ?? '');
  for (const c of TERMINAL) {
    if (!c.match.test(text)) continue;
    // "· resets 9:30pm (Asia/Calcutta)" — when the message says when, say when. A park that
    // names the hour is one an operator can act on without going to find the raw output.
    const resets = /resets?\s+([^)\n]{1,40}\)|[0-9][^·\n]{0,30})/i.exec(text);
    const fix = resets && c.code === 'usage-exhausted'
      ? `resets ${resets[1].trim()} — \`autodev resume <id>\` after that`
      : c.fix;
    return { code: c.code, reason: c.reason, fix };
  }
  return null; // fail open: an unrecognized failure keeps today's behaviour exactly
}

// Bound a channel so a runaway session cannot fill the operator's disk. Head keeps the
// context the session started in, tail keeps the cause; the middle is thinking out loud.
export function clamp(text, max = KEEP, head = HEAD) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, head)}\n… ${s.length - max} bytes elided …\n${s.slice(-(max - head))}`;
}

// One delimited, attributable block for runner.log. Returns a string and writes nothing —
// the caller decides whether a log write is worth risking (it never is: see FR-007).
// The prompt is deliberately absent: it is in the source, and its presence in the diagnosis
// is the very defect this feature exists to remove.
export function sessionBlock({ run, stage, title, attempt, outcome, ms, classified, stdout, stderr }) {
  const secs = Number.isFinite(ms) ? ` · ${(ms / 1000).toFixed(1)}s` : '';
  const out = [`--- run ${run} · stage ${stage} (${title}) · attempt ${attempt} · ${outcome}`
    + `${secs}${classified ? ` · ${classified}` : ''} ---`];
  for (const [name, body] of [['stdout', stdout], ['stderr', stderr]]) {
    const text = clamp(body);
    if (text.trim()) out.push(`[${name}]`, text.replace(/\n+$/, ''));
  }
  out.push(`--- end stage ${stage} attempt ${attempt} ---`, '');
  return out.join('\n');
}
