import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-repo .autodev.json (checked into the target repo, not autodev itself).
// Precedence everywhere: CLI flag > .autodev.json > env var > built-in default.
// Recognized keys: testCmd, model, stageModels, maxCostUsd, until, push, branchPrefix.
export function repoConfig(repoPath) {
  try { return JSON.parse(readFileSync(join(repoPath, '.autodev.json'), 'utf8')); }
  catch { return {}; }
}

// Model for one stage session: per-stage map > repo-wide model > env pin > CLI default.
export const modelFor = (cfg, stageKey) =>
  cfg.stageModels?.[stageKey] || cfg.model || process.env.AUTODEV_CLAUDE_MODEL || null;
