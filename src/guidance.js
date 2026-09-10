// The guidance layer: what the target repo tells autodev about itself, and where the
// holdout scenarios live while the builder must not see them.
//
// Two files, both optional, both in the TARGET repo under .autodev/:
//   mission.md       — goals and non-goals. Their only job is to let a spec session
//                      REJECT a requirement, so the pipeline can correct the operator
//                      instead of only ever obeying them.
//   factory-rules.md — constraints that apply only when the agent is running
//                      unsupervised. Stricter than the repo's CLAUDE.md, which applies
//                      when a human is in the loop and can catch an overreach.
//
// Both are absent by default and the pipeline behaves exactly as it did without them.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, cpSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

export const MISSION = '.autodev/mission.md';
export const FACTORY_RULES = '.autodev/factory-rules.md';
export const HOLDOUT_DIR = '.autodev/holdout';
export const TRIAGE = '.autodev/triage.json';
export const HOLDOUT_VERDICT = '.autodev/holdout.json';

const readIf = (root, rel) => {
  try { const s = readFileSync(join(root, rel), 'utf8').trim(); return s || null; }
  catch { return null; }
};

export const mission = (worktree) => readIf(worktree, MISSION);
export const factoryRules = (worktree) => readIf(worktree, FACTORY_RULES);

// Prepended to EVERY stage prompt. Rules first because a constraint read after the
// instruction it constrains is a constraint the session has already planned around.
export function promptPrefix(worktree) {
  const rules = factoryRules(worktree);
  return rules
    ? `You are running unsupervised inside an autodev pipeline. These factory rules are binding for every action you take in this repository; they override your own judgement about scope and pace:\n\n${rules}\n\n---\n\n`
    : '';
}

// The scope contract handed to the spec stage. Absent mission.md → empty string, and the
// stage never writes a triage verdict, so the run cannot be rejected. That is deliberate:
// rejection is a capability the operator opts into by writing down what is out of scope.
export function triageClause(worktree) {
  const m = mission(worktree);
  if (!m) return '';
  return `\n\nBEFORE writing any spec, judge this requirement against the repository's mission:\n\n<mission>\n${m}\n</mission>\n\nWrite your judgement as JSON to ${TRIAGE} in the repo root: {"verdict":"ACCEPT"|"REJECT","reason":"<one or two sentences>"}. REJECT when the requirement is a non-goal, contradicts the mission, or is too large to build and verify in one pass — say which. A REJECT stops the run before any code is written, so reject on scope, never on difficulty alone. On REJECT, write the file and stop; produce no spec.`;
}

// Holdout scenarios: acceptance criteria written from the spec, BEFORE implementation, by a
// session that is not the builder — then moved out of the worktree so the builder cannot
// read, satisfy, or edit them. Without the move this is just another test file the builder
// optimizes against, which is the failure mode the whole idea exists to prevent.
export const holdoutClause = () =>
  `\n\nAlso write ${HOLDOUT_DIR}/scenarios.md: numbered end-to-end acceptance scenarios for the FEATURE AS SPECIFIED, each as Given/When/Then in terms an operator would use, plus how to observe the result. Describe only externally visible behaviour — no file names, function names, or implementation detail, because these scenarios are checked by a separate session that must not be steered toward the implementation. Keep it under 10 scenarios.`;

// Keep the holdout directory out of git BEFORE the spec session can `git add -A` it.
// Sequestering the files is not enough on its own: once they are in a commit, the builder
// can read them out of the history the sequester was supposed to hide them from. Written to
// .git/info/exclude, which is per-checkout and never committed — resolved via rev-parse
// because a worktree's .git is a file pointing elsewhere, not a directory.
export function excludeHoldout(worktree) {
  try {
    const p = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'],
      { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
    const abs = isAbsolute(p) ? p : join(worktree, p);
    const line = `${HOLDOUT_DIR}/\n`;
    const cur = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    if (cur.includes(line.trim())) return true;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, cur + (cur.endsWith('\n') || !cur ? '' : '\n') + line);
    return true;
  } catch { return false; } // no git-path (not a repo) — sequester still runs, history may show it
}

// Move .autodev/holdout out of the worktree into the run directory. Returns true if there
// was anything to sequester. Called the moment the spec stage's gate passes, so no later
// session ever sees the directory on disk.
export function sequesterHoldout(worktree, runDirPath) {
  const from = join(worktree, HOLDOUT_DIR);
  if (!existsSync(from)) return false;
  const to = join(runDirPath, 'holdout');
  rmSync(to, { recursive: true, force: true });
  mkdirSync(runDirPath, { recursive: true });
  // rename is atomic but fails across devices (a worktree on another volume than
  // AUTODEV_HOME) — copy+remove is the portable fallback, same end state.
  try { renameSync(from, to); }
  catch { cpSync(from, to, { recursive: true }); rmSync(from, { recursive: true, force: true }); }
  return true;
}

// Put them back just long enough for the validating session to read them.
export function restoreHoldout(worktree, runDirPath) {
  const from = join(runDirPath, 'holdout');
  if (!existsSync(from)) return false;
  cpSync(from, join(worktree, HOLDOUT_DIR), { recursive: true });
  return true;
}

export const clearHoldout = (worktree) =>
  rmSync(join(worktree, HOLDOUT_DIR), { recursive: true, force: true });

export const hasHoldout = (runDirPath) => existsSync(join(runDirPath, 'holdout', 'scenarios.md'));
