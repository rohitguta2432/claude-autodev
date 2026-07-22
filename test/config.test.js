import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFor } from '../src/config.js';

test('modelFor: per-stage > repo model > env pin > null', () => {
  const cfg = { model: 'claude-sonnet-5', stageModels: { review: 'claude-opus-4-8' } };
  assert.equal(modelFor(cfg, 'review'), 'claude-opus-4-8');
  assert.equal(modelFor(cfg, 'implement'), 'claude-sonnet-5');
  process.env.AUTODEV_CLAUDE_MODEL = 'claude-haiku-4-5';
  assert.equal(modelFor({}, 'spec'), 'claude-haiku-4-5');
  delete process.env.AUTODEV_CLAUDE_MODEL;
  assert.equal(modelFor({}, 'spec'), null);
});
