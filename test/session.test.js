import { test } from 'node:test';
import assert from 'node:assert/strict';
import { causeLine, classify, clamp, sessionBlock } from '../src/session.js';

test('causeLine: empty, whitespace-only and decorative input yield nothing to report', () => {
  assert.equal(causeLine(''), '');
  assert.equal(causeLine(null), '');
  assert.equal(causeLine('   \n\n\t\n'), '');
  assert.equal(causeLine('───────\n═══\n***'), ''); // rules carry no letter or digit
});

test('causeLine: reports the tail, skipping blanks and rules', () => {
  const out = 'starting\nreading files\nthinking\n\nworking…\n\nNot logged in · Please run /login\n\n────────\n';
  const line = causeLine(out);
  assert.match(line, /Not logged in/);
  assert.doesNotMatch(line, /────/);          // rules are skipped even though they are last
  assert.doesNotMatch(line, /starting/);      // only the final content lines, not the whole log
});

test('causeLine: collapses whitespace and caps length', () => {
  assert.equal(causeLine('a     b\t\tc'), 'a b c');
  const long = 'x'.repeat(5000);
  assert.equal(causeLine(long).length, 300);
  assert.equal(causeLine(long, 40).length, 40);
});

test('classify: ENOENT is structural and wins over everything', () => {
  const c = classify({ code: 'ENOENT', out: 'usage limit reached' });
  assert.equal(c.code, 'claude-not-found');
  assert.match(c.fix, /AUTODEV_CLAUDE_BIN|install/);
});

test('classify: recognises the two textual conditions and names a remedy', () => {
  const auth = classify({ out: 'Not logged in · Please run /login' });
  assert.equal(auth.code, 'not-authenticated');
  assert.match(auth.fix, /sign in/);

  const usage = classify({ out: 'Claude usage limit reached. Your limit will reset at 3pm.' });
  assert.equal(usage.code, 'usage-exhausted');
  assert.match(usage.fix, /reset|raise/);
});

test('classify: the wording the CLI actually uses for a limit parks on the first attempt', () => {
  // Run #567, 2026-09-13. This exact string fell through the classifier: three sessions
  // bought in 18 seconds against an allowance that reset four minutes later, the stage's
  // retry budget spent, and the run parked anyway — for two hours, until a person resumed it.
  const weekly = classify({ out: "You've hit your weekly limit · resets 9:30pm (Asia/Calcutta)" });
  assert.equal(weekly?.code, 'usage-exhausted');
  // The message says when; the park reason must say when.
  assert.match(weekly.fix, /resets 9:30pm \(Asia\/Calcutta\)/);
  assert.match(weekly.fix, /autodev resume/);

  // The other shapes the CLI produces.
  assert.equal(classify({ out: '5-hour limit reached · resets 3am' })?.code, 'usage-exhausted');
  assert.equal(classify({ out: "You've hit your usage limit" })?.code, 'usage-exhausted');

  // Rate limiting is NOT a park — that is what retries are for (see TERMINAL's note).
  assert.equal(classify({ out: 'the tests hit the rate limit and passed on retry' }), null);
});

test('classify: fails open on anything unrecognised', () => {
  assert.equal(classify({ out: 'TypeError: undefined is not a function' }), null);
  assert.equal(classify({ out: '' }), null);
  assert.equal(classify({}), null);
  assert.equal(classify(), null);
});

test('classify: a rate limit is NOT terminal — that is what retries are for', () => {
  assert.equal(classify({ out: 'Error: 429 rate limit, please retry' }), null);
  assert.equal(classify({ out: 'rate_limit_error: too many requests' }), null);
});

test('classify: a two-condition collision resolves by fixed order, not by chance', () => {
  const both = 'Not logged in · Please run /login\nAlso: usage limit reached';
  assert.equal(classify({ out: both }).code, 'not-authenticated');
  assert.equal(classify({ out: both.split('\n').reverse().join('\n') }).code, 'not-authenticated');
});

test('clamp: passes short input through and elides the middle of long input', () => {
  assert.equal(clamp('short'), 'short');
  const body = 'H'.repeat(50) + 'M'.repeat(500) + 'T'.repeat(50);
  const out = clamp(body, 100, 40);
  assert.match(out, /bytes elided/);
  assert.ok(out.startsWith('H'.repeat(40)), 'head is kept');
  assert.ok(out.endsWith('T'.repeat(50)), 'tail is kept — the cause lives there');
  assert.ok(out.length < body.length);
});

test('sessionBlock: header carries run, stage, attempt, outcome, duration', () => {
  const b = sessionBlock({ run: 7, stage: 3, title: 'Implement', attempt: 2,
    outcome: 'exit 1', ms: 1600, stdout: 'boom', stderr: '' });
  assert.match(b, /^--- run 7 · stage 3 \(Implement\) · attempt 2 · exit 1 · 1\.6s ---$/m);
  assert.match(b, /--- end stage 3 attempt 2 ---/);
});

test('sessionBlock: empty sections are omitted, not left blank', () => {
  const b = sessionBlock({ run: 1, stage: 1, title: 'Spec', attempt: 1,
    outcome: 'exit 1', ms: 10, stdout: 'only out', stderr: '   \n' });
  assert.match(b, /\[stdout\]\nonly out/);
  assert.doesNotMatch(b, /\[stderr\]/);
});

test('sessionBlock: classification appears in the header only when present', () => {
  const withC = sessionBlock({ run: 1, stage: 1, title: 'Spec', attempt: 1, outcome: 'exit 1',
    ms: 10, classified: 'not-authenticated', stdout: 'x', stderr: '' });
  assert.match(withC, /· not-authenticated ---/);
  const withoutC = sessionBlock({ run: 1, stage: 1, title: 'Spec', attempt: 1, outcome: 'exit 1',
    ms: 10, stdout: 'x', stderr: '' });
  assert.doesNotMatch(withoutC, /· undefined/);
});

test('sessionBlock: each channel is clamped independently', () => {
  const huge = 'z'.repeat(3 * 1024 * 1024);
  const b = sessionBlock({ run: 1, stage: 1, title: 'Spec', attempt: 1, outcome: 'exit 1',
    ms: 10, stdout: huge, stderr: huge });
  assert.match(b, /bytes elided/);
  assert.ok(b.length < 2.5 * 1024 * 1024, `block should be bounded, got ${b.length}`);
});

test('causeLine: a --output-format json result line is reported by its `result`, not its counters', () => {
  const blob = JSON.stringify({ type: 'result', is_error: true, total_cost_usd: 0, usage: { input_tokens: 0 },
    result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
  const line = causeLine(`(node:1) ExperimentalWarning: x\n${blob}\n`);
  assert.equal(line, '(node:1) ExperimentalWarning: x / Failed to authenticate: OAuth session expired and could not be refreshed');
  assert.doesNotMatch(line, /total_cost_usd/);
});

test('classify: the CLI\'s own OAuth wording is a terminal auth condition', () => {
  assert.equal(classify({ out: 'Failed to authenticate: OAuth session expired and could not be refreshed' }).code, 'not-authenticated');
  assert.equal(classify({ out: 'OAuth session expired' }).code, 'not-authenticated');
});
