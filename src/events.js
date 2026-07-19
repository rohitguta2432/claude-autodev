import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PORT } from './db.js';

// ctx: { runDir, port? } — jsonl append is mandatory, POST is best-effort.
export async function emit(ctx, event) {
  const ev = { ts: Date.now(), ...event };
  mkdirSync(ctx.runDir, { recursive: true });
  appendFileSync(join(ctx.runDir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  try {
    await fetch(`http://127.0.0.1:${ctx.port ?? PORT()}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* ponytail: server optional by design — jsonl is the source of truth */ }
  return ev;
}
