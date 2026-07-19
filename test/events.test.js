import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

process.env.AUTODEV_HOME = mkdtempSync(join(tmpdir(), 'autodev-ev-'));
const { emit } = await import('../src/events.js');

test('emit appends jsonl even when server is down, and POSTs when up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-'));
  // server down (port 1 refuses)
  await emit({ runDir: dir, port: 1 }, { run: 7, type: 'stage_started', stage: 1 });
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assert.equal(ev.type, 'stage_started');
  assert.ok(ev.ts > 0);

  // server up
  const received = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { received.push(JSON.parse(b)); res.end('ok'); });
  });
  await new Promise(r => srv.listen(0, r));
  await emit({ runDir: dir, port: srv.address().port }, { run: 7, type: 'run_done', stage: 6 });
  srv.close();
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'run_done');
});
