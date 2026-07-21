import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeResult } from '../src/metrics.js';

test('parseClaudeResult: extracts text, tokens, models, cost from CLI result JSON', () => {
  const raw = JSON.stringify({
    type: 'result', result: 'done.', duration_ms: 12000, total_cost_usd: 0.21,
    usage: { input_tokens: 400, cache_creation_input_tokens: 3000, cache_read_input_tokens: 15000, output_tokens: 6200 },
    modelUsage: { 'claude-opus-4-8': { outputTokens: 6000 }, 'claude-haiku-4-5-20251001': { outputTokens: 200 } },
  });
  const { text, metrics } = parseClaudeResult(raw);
  assert.equal(text, 'done.');
  assert.equal(metrics.tokens_in, 18400);
  assert.equal(metrics.tokens_out, 6200);
  assert.equal(metrics.cost_usd, 0.21);
  assert.equal(metrics.model, 'claude-opus-4-8 + claude-haiku-4-5'); // date suffix stripped
  assert.equal(metrics.duration_ms, 12000);
});

test('parseClaudeResult: plain text and non-result JSON fall through with null metrics', () => {
  assert.deepEqual(parseClaudeResult('plain stub output'), { text: 'plain stub output', metrics: null });
  const other = JSON.stringify({ type: 'other' });
  assert.deepEqual(parseClaudeResult(other), { text: other, metrics: null });
});
