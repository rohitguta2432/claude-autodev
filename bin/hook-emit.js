#!/usr/bin/env node
import { emit } from '../src/events.js';

try {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const hook = JSON.parse(raw);
  const file = hook.tool_input?.file_path || hook.tool_input?.command || '';
  if (!file) process.exit(0);
  await emit(
    { runDir: process.env.AUTODEV_RUN_DIR, port: Number(process.env.AUTODEV_PORT) },
    { run: Number(process.env.AUTODEV_RUN), type: 'activity',
      stage: Number(process.env.AUTODEV_STAGE), detail: `✎ ${file}` },
  );
} catch { /* never fail the session over telemetry */ }
