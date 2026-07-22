import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('autodev selftest drives all 7 stages green and exits 0', () => {
  const out = execFileSync('node', ['bin/autodev.js', 'selftest'],
    { encoding: 'utf8', env: { ...process.env, AUTODEV_CLAUDE_BIN: undefined } });
  assert.match(out, /selftest PASS/);
  for (const s of ['Spec', 'Analyze', 'Implement', 'Verify', 'Push', 'Review', 'Test'])
    assert.match(out, new RegExp(`${s}\\s+OK`));
});
