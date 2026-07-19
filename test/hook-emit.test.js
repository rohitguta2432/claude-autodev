import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('hook-emit writes activity event from PostToolUse stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/w/src/app.ts' } });
  execFileSync('node', ['bin/hook-emit.js'], {
    input,
    env: { ...process.env, AUTODEV_RUN: '9', AUTODEV_RUN_DIR: dir, AUTODEV_PORT: '1', AUTODEV_STAGE: '3' },
  });
  const ev = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim());
  assert.equal(ev.type, 'activity');
  assert.equal(ev.run, 9);
  assert.equal(ev.stage, 3);
  assert.match(ev.detail, /app\.ts/);
});
