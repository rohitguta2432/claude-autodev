import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AUTODEV_HOME, PORT } from './db.js';
import { detectTestCmd } from './stages.js';
import { repoConfig } from './config.js';

const ver = (bin, args = ['--version']) => {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 10_000 }).trim().split('\n')[0]; }
  catch { return null; }
};

// Preflight checks — a stranger's first failure should cost five seconds, not a
// 45-minute stage timeout. Each check carries its own remediation text.
// severity: 'fail' blocks `autodev run`; 'warn' prints but proceeds.
export async function doctor(repoPath = process.cwd()) {
  const checks = [];
  const add = (ok, name, detail, fix, severity = 'fail') =>
    checks.push({ ok, name, detail, fix, severity: ok ? 'pass' : severity });

  const [maj, min] = process.versions.node.split('.').map(Number);
  add(maj > 22 || (maj === 22 && min >= 5), 'node >= 22.5', `found ${process.versions.node}`,
    'install Node 22.5+ (needs node:sqlite)');

  add(!!ver('git'), 'git on PATH', ver('git') ?? 'not found', 'install git');

  const claudeBin = process.env.AUTODEV_CLAUDE_BIN || 'claude';
  const claudeV = claudeBin.endsWith('.js') ? 'stub' : ver(claudeBin);
  add(!!claudeV, 'claude CLI on PATH', claudeV ?? 'not found',
    'install Claude Code: https://claude.com/claude-code — then run `claude` once to authenticate');

  add(!process.env.ANTHROPIC_API_KEY, 'no ANTHROPIC_API_KEY in env', process.env.ANTHROPIC_API_KEY
    ? 'set — headless sessions will bill per token to this key, NOT your subscription'
    : 'unset — sessions use your Claude Code login',
    'unset ANTHROPIC_API_KEY unless per-token API billing is intended', 'warn');

  add(!!ver('gh'), 'gh CLI (optional, for PRs)', ver('gh') ?? 'not found',
    'install https://cli.github.com/ and `gh auth login` — without it the Push stage cannot open a PR', 'warn');

  let head = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8', timeout: 10_000 }).trim(); }
  catch { /* not a repo or zero commits */ }
  add(!!head, 'target is a git repo with a commit', head ? `HEAD ${head.slice(0, 7)} (${repoPath})` : `no resolvable HEAD in ${repoPath}`,
    'run from a git repo with at least one commit, or pass --repo <path>');

  const testCmd = repoConfig(repoPath).testCmd || (head ? detectTestCmd(repoPath) : null);
  add(!!testCmd, 'test command detectable', testCmd ?? 'none found',
    'pass --test-cmd "<cmd>" or set "testCmd" in .autodev.json — the Test stage parks without one', 'warn');

  for (const [name, dir] of [['AUTODEV_HOME writable', AUTODEV_HOME()],
    ['worktree root writable', process.env.AUTODEV_WORKTREES || join(homedir(), 'worktrees')]]) {
    let ok = true;
    try { mkdirSync(dir, { recursive: true }); accessSync(dir, constants.W_OK); } catch { ok = false; }
    add(ok, name, dir, `make ${dir} writable or point its env var elsewhere`);
  }

  try {
    const r = await fetch(`http://127.0.0.1:${PORT()}/api/runs`, { signal: AbortSignal.timeout(1000) });
    add(r.ok, `dashboard port ${PORT()}`, r.ok ? 'autodev server already running' : `port answers but not autodev (HTTP ${r.status})`,
      `free port ${PORT()} or set AUTODEV_PORT`, 'warn');
  } catch { add(true, `dashboard port ${PORT()}`, 'free — server will be started on demand'); }

  return checks;
}

export function printChecks(checks) {
  for (const c of checks) {
    const tag = c.severity === 'pass' ? ' PASS ' : c.severity === 'warn' ? ' WARN ' : ' FAIL ';
    console.log(`[${tag}] ${c.name} — ${c.detail}${c.severity === 'pass' ? '' : `\n         fix: ${c.fix}`}`);
  }
  return checks.filter(c => c.severity === 'fail');
}
