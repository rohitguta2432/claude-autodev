import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFor, effortFor, DEFAULT_MODEL, DEFAULT_EFFORT } from '../src/config.js';

test('modelFor: per-stage > repo model > env pin > claude-fable-5', () => {
  const cfg = { model: 'claude-sonnet-5', stageModels: { review: 'claude-opus-4-8' } };
  assert.equal(modelFor(cfg, 'review'), 'claude-opus-4-8');
  assert.equal(modelFor(cfg, 'implement'), 'claude-sonnet-5');
  process.env.AUTODEV_CLAUDE_MODEL = 'claude-haiku-4-5';
  assert.equal(modelFor({}, 'spec'), 'claude-haiku-4-5');
  delete process.env.AUTODEV_CLAUDE_MODEL;
  // The default moved from Opus 5 to Fable 5 when it shipped (specs/003, amended 2026-09-10):
  // the strongest model at the highest effort is the standing rule, and which model that is
  // follows the family.
  assert.equal(modelFor({}, 'spec'), 'claude-fable-5');
  assert.equal(DEFAULT_MODEL, 'claude-fable-5');
});

test('effortFor: per-stage > repo effort > env pin > max', () => {
  const cfg = { effort: 'high', stageEffort: { push: 'low' } };
  assert.equal(effortFor(cfg, 'push'), 'low');
  assert.equal(effortFor(cfg, 'implement'), 'high');
  process.env.AUTODEV_CLAUDE_EFFORT = 'medium';
  assert.equal(effortFor({}, 'spec'), 'medium');
  delete process.env.AUTODEV_CLAUDE_EFFORT;
  assert.equal(effortFor({}, 'spec'), 'max');
  assert.equal(DEFAULT_EFFORT, 'max');
});
