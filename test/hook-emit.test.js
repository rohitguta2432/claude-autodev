import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const env = (dir) => ({ ...process.env, AUTODEV_RUN: '9', AUTODEV_RUN_DIR: dir, AUTODEV_PORT: '1', AUTODEV_STAGE: '3' });

test('hook-emit writes activity event from PostToolUse stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/w/src/app.ts' } });
  execFileSync('node', ['bin/hook-emit.js'], { input, env: env(dir) });
  const ev = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim());
  assert.equal(ev.type, 'activity');
  assert.equal(ev.run, 9);
  assert.equal(ev.stage, 3);
  assert.match(ev.detail, /app\.ts/);
});

test('hook-emit exits 0 on malformed JSON and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  execFileSync('node', ['bin/hook-emit.js'], { input: 'not json{{{', env: env(dir) });
  assert.equal(existsSync(join(dir, 'events.jsonl')), false);
});

test('hook-emit falls back to tool_input.command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  execFileSync('node', ['bin/hook-emit.js'], { input, env: env(dir) });
  const ev = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim());
  assert.equal(ev.type, 'activity');
  assert.match(ev.detail, /npm test/);
});

test('hook-emit exits 0 on empty tool_input and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  const input = JSON.stringify({ tool_name: 'Read', tool_input: {} });
  execFileSync('node', ['bin/hook-emit.js'], { input, env: env(dir) });
  assert.equal(existsSync(join(dir, 'events.jsonl')), false);
});
