import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getRun, updateRun, runDir, PORT, skippedSet } from './db.js';
import { emit } from './events.js';
import { STAGES, detectTestCmd } from './stages.js';
import { repoConfig } from './config.js';
import { parseClaudeResult } from './metrics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = { maxRetries: 2, reviewLoops: 3, stageTimeoutMin: 45, budgetHours: 6 };

const runId = Number(process.argv[2]);
const resume = process.argv.includes('--resume');
const db = openDb();
const run = getRun(db, runId);
if (!run) { console.error(`no run ${runId}`); process.exit(1); }
const ctx = { runDir: runDir(runId), port: PORT() };
mkdirSync(ctx.runDir, { recursive: true });
const started = Date.now();
const ev = (e) => emit(ctx, { run: runId, ...e });
const saveState = (fields) => { updateRun(db, runId, fields);
  writeFileSync(join(ctx.runDir, 'state.json'), JSON.stringify({ ...getRun(db, runId) })); };

// Hooks settings for headless sessions → live activity events.
const hooksFile = join(ctx.runDir, 'hooks.json');
writeFileSync(hooksFile, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit',
  hooks: [{ type: 'command', command: `node ${join(ROOT, 'bin/hook-emit.js')}` }] }] } }));

function runClaude(prompt, stageN) {
  const bin = process.env.AUTODEV_CLAUDE_BIN || 'claude';
  const model = process.env.AUTODEV_CLAUDE_MODEL; // pin a (cheaper) model for every stage session
  const args = process.env.AUTODEV_CLAUDE_BIN
    ? ['-p', prompt] // stub in tests
    : ['-p', prompt, '--dangerously-skip-permissions', '--settings', hooksFile, '--output-format', 'json',
       ...(model ? ['--model', model] : [])];
  // A .js AUTODEV_CLAUDE_BIN (test stubs) runs via node — extensionless scripts can't spawn on Windows.
  const [file, argv] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
  const raw = execFileSync(file, argv, {
    cwd: run.worktree, encoding: 'utf8', timeout: CFG.stageTimeoutMin * 60_000,
    env: { ...process.env, AUTODEV_RUN: String(runId), AUTODEV_RUN_DIR: ctx.runDir,
      AUTODEV_PORT: String(ctx.port), AUTODEV_STAGE: String(stageN) },
  });
  // Per-session telemetry (tokens / model / cost) from the CLI's result JSON — one
  // metrics event per claude call, so review/fix loops surface their true spend.
  const { text, metrics } = parseClaudeResult(raw);
  if (metrics) ev({ type: 'metrics', stage: stageN, ...metrics });
  return text;
}

async function park(stage, err, output = '') {
  const reason = String(err.message || err).slice(0, 300);
  writeFileSync(join(ctx.runDir, 'blocked.md'),
    `# Run ${runId} blocked at stage ${stage.n} (${stage.title})\n\n**Reason:** ${reason}\n\n## Last output\n\n\`\`\`\n${output.slice(-4000)}\n\`\`\`\n`);
  saveState({ status: 'BLOCKED', stage: stage.n, blocked_reason: reason });
  await ev({ type: 'parked', stage: stage.n, detail: reason });
  process.exit(0);
}

async function reviewStage(stage) { // inner review⇄fix loop
  for (let round = 1; round <= CFG.reviewLoops; round++) {
    rmSync(join(run.worktree, '.autodev/review.json'), { force: true });
    await ev({ type: 'activity', stage: stage.n, detail: `review round ${round}/${CFG.reviewLoops}` });
    runClaude(stage.prompt(run), stage.n);
    try { stage.check(run); return; }
    catch (e) {
      const p = join(run.worktree, '.autodev/review.json');
      if (!existsSync(p)) throw e; // review session broke — outer retry handles it
      if (round === CFG.reviewLoops) { e.final = true; throw e; } // internal budget spent — park directly
      const { findings } = JSON.parse(readFileSync(p, 'utf8'));
      await ev({ type: 'retry', stage: stage.n, detail: `${findings?.length ?? '?'} findings — fixing` });
      runClaude(stage.fixPrompt(run, findings), stage.n);
    }
  }
}

async function testStage(stage) {
  // precedence: --test-cmd (run row) > repo .autodev.json > detection — never a silent pass.
  const cmd = run.test_cmd || repoConfig(run.worktree).testCmd || detectTestCmd(run.worktree);
  if (!cmd) {
    run._testsPassed = false;
    throw Object.assign(new Error(
      'no test command detected — pass --test-cmd "<cmd>" or set "testCmd" in .autodev.json; "tested PR out" must never be vacuous'), { final: true });
  }
  await ev({ type: 'activity', stage: stage.n, detail: `test command: ${cmd}` });
  mkdirSync(join(run.worktree, '.autodev'), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const out = execSync(cmd, { cwd: run.worktree, encoding: 'utf8', timeout: CFG.stageTimeoutMin * 60_000 });
      writeFileSync(join(run.worktree, '.autodev/test-output.txt'), out); run._testsPassed = true; return;
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      writeFileSync(join(run.worktree, '.autodev/test-output.txt'), out);
      if (attempt >= CFG.maxRetries) { run._testsPassed = false;
        throw Object.assign(new Error(`tests still failing after ${attempt} fix attempts`), { final: true }); }
      await ev({ type: 'retry', stage: stage.n, detail: `tests failed — fix attempt ${attempt + 1}` });
      runClaude(stage.prompt(run), stage.n);
    }
  }
}

// ---- main loop ----
if (resume) { saveState({ status: 'RUNNING', blocked_reason: null }); await ev({ type: 'resumed', stage: run.stage }); }
saveState({ pid: process.pid });

const skipped = skippedSet(run); // stages the user skipped from the dashboard — bypassed here too
for (const stage of STAGES.filter(s => s.n >= run.stage && !skipped.has(s.n))) {
  if (Date.now() - started > CFG.budgetHours * 3_600_000) await park(stage, new Error('wall-clock budget exceeded'));
  saveState({ stage: stage.n });
  await ev({ type: 'stage_started', stage: stage.n, detail: stage.title });
  let lastErr, lastOut = '';
  let ok = false;
  for (let attempt = 0; attempt <= CFG.maxRetries && !ok; attempt++) {
    try {
      if (stage.key === 'review') await reviewStage(stage);
      else if (stage.key === 'test') await testStage(stage);
      else {
        const extra = lastErr ? `\n\nA previous attempt failed its verification: ${lastErr.message}. Address that specifically.` : '';
        lastOut = runClaude(stage.prompt(run) + extra, stage.n);
        stage.check(run);
      }
      ok = true;
    } catch (e) {
      lastErr = e; lastOut = String(e.stdout ?? lastOut);
      if (e.final) break; // stage's internal budget exhausted — no outer re-runs
      if (attempt < CFG.maxRetries) await ev({ type: 'retry', stage: stage.n, detail: String(e.message).slice(0, 200) });
    }
  }
  if (!ok) await park(stage, lastErr, lastOut);
  if (stage.key === 'push' && existsSync(join(run.worktree, '.autodev/pr-url'))) {
    const url = readFileSync(join(run.worktree, '.autodev/pr-url'), 'utf8').trim();
    saveState({ pr_url: url }); await ev({ type: 'pr_opened', stage: stage.n, detail: url });
  }
  await ev({ type: 'stage_done', stage: stage.n, detail: stage.title });
}
saveState({ status: 'DONE' });
await ev({ type: 'run_done', stage: STAGES.at(-1).n });
db.close();
