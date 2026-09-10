import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-repo .autodev.json (checked into the target repo, not autodev itself).
// Precedence everywhere: CLI flag > .autodev.json > env var > built-in default.
// Recognized keys: testCmd, model, stageModels, effort, stageEffort, until, push, branchPrefix, worktreeCopy, deploy, skip.
export function repoConfig(repoPath) {
  try { return JSON.parse(readFileSync(join(repoPath, '.autodev.json'), 'utf8')); }
  catch { return {}; }
}

// The built-in defaults for every stage session (specs/003): the strongest model at the
// highest effort. A pipeline nobody is watching should not be the place to save on thinking.
export const DEFAULT_MODEL = 'claude-fable-5';
export const DEFAULT_EFFORT = 'max';

// Model for one stage session: per-stage map > repo-wide model > env pin > DEFAULT_MODEL.
export const modelFor = (cfg, stageKey) =>
  cfg.stageModels?.[stageKey] || cfg.model || process.env.AUTODEV_CLAUDE_MODEL || DEFAULT_MODEL;

// Effort for one stage session, same chain: per-stage > repo-wide > env pin > DEFAULT_EFFORT.
export const effortFor = (cfg, stageKey) =>
  cfg.stageEffort?.[stageKey] || cfg.effort || process.env.AUTODEV_CLAUDE_EFFORT || DEFAULT_EFFORT;
