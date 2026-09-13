import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFor, effortFor, DEFAULT_MODEL, DEFAULT_EFFORT } from '../src/config.js';

test('modelFor: per-stage > repo model > env pin > claude-fable-5-1', () => {
  const cfg = { model: 'claude-sonnet-5', stageModels: { review: 'claude-opus-4-8' } };
  assert.equal(modelFor(cfg, 'review'), 'claude-opus-4-8');
  assert.equal(modelFor(cfg, 'implement'), 'claude-sonnet-5');
  process.env.AUTODEV_CLAUDE_MODEL = 'claude-haiku-4-5';
  assert.equal(modelFor({}, 'spec'), 'claude-haiku-4-5');
  delete process.env.AUTODEV_CLAUDE_MODEL;
  // The default moved from Opus 5 to Fable 5 when it shipped (specs/003, amended 2026-09-10):
  // the strongest model at the highest effort is the standing rule, and which model that is
  // follows the family.
  assert.equal(modelFor({}, 'spec'), 'claude-fable-5-1');
  assert.equal(DEFAULT_MODEL, 'claude-fable-5-1');
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

test('runner.js imports every stages.js name it calls at module load', async () => {
  // A standing .autodev.json "skip" list crashed the runner at startup with
  // "ReferenceError: stageN is not defined" — before any stage, so no event, no park:
  // the run sat RUNNING until an operator stopped it by hand (run #9, 2026-09-10).
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/runner.js', import.meta.url), 'utf8');
  const imported = /from '\.\/stages\.js';/.exec(src) && src.slice(0, src.indexOf("from './stages.js';"));
  assert.match(src, /\bstageN\(/, 'the skip list still resolves names through stageN');
  assert.match(imported, /\bstageN\b/, 'stageN is used but not imported from stages.js');
});
