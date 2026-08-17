import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AUTODEV_HOME, PORT } from './db.js';
import { detectTestCmd, markerSubdirs, hasTestSources } from './stages.js';
import { repoConfig } from './config.js';

const ver = (bin, args = ['--version']) => {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim().split('\n')[0]; }
  catch { return null; }
};

// "https://github.com/OWNER/x.git" | "git@github.com:OWNER/x.git" -> {host, owner};
// null when unparseable. Exported for tests; the gh-login half needs auth and is not CI-testable.
export function originOwner(url) {
  const m = String(url ?? '').trim().match(/^(?:https?:\/\/([^/]+)\/|(?:ssh:\/\/)?git@([^:/]+)(?::(?=\d+\/)\d+)?[:/])([^/\s]+)\/\S+/);
  return m ? { host: (m[1] || m[2]).replace(/^.*@/, '').replace(/:\d+$/, ''), owner: m[3] } : null;
}

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

  const ghV = ver('gh'); // hoisted: reused below so a doctor pass spawns gh fewer times
  add(!!ghV, 'gh CLI (optional, for PRs)', ghV ?? 'not found',
    'install https://cli.github.com/ and `gh auth login` (without it the Push stage cannot open a PR)', 'warn');

  // Stage 5 pushes and PRs from whatever account gh has active, which on someone else's
  // repo is usually the wrong one. Silence when indeterminate; a mismatch is a WARN, not
  // a FAIL: org repos and fork flows are legitimate and only the operator knows which this is.
  let origin = null;
  try { origin = execFileSync('git', ['remote', 'get-url', 'origin'],
    { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true }).trim(); } catch {}
  const oo = originOwner(origin);
  if (oo && ghV) {
    const login = ver('gh', ['api', '--hostname', oo.host, 'user', '--jq', '.login']);
    if (login) add(login.toLowerCase() === oo.owner.toLowerCase(), 'gh account matches origin owner',
      login.toLowerCase() === oo.owner.toLowerCase() ? `${login}`
        : `active gh account "${login}" does not own origin "${oo.owner}" (${oo.host}); stage 5 would push and PR from that account`,
      'gh auth switch to the owning account, or ignore for org-owned repos and fork flows', 'warn');
  }

  let head = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim(); }
  catch { /* not a repo or zero commits */ }
  add(!!head, 'target is a git repo with a commit', head ? `HEAD ${head.slice(0, 7)} (${repoPath})` : `no resolvable HEAD in ${repoPath}`,
    'run from a git repo with at least one commit, or pass --repo <path>');

  // Gitignored build config never reaches the fresh worktree a run builds in; an
  // Android/JVM repo fails its first run on exactly this. Root-level, named files only:
  // this is a nudge toward worktreeCopy, not a scanner.
  if (head) {
    const cfg = repoConfig(repoPath);
    const copies = new Set(Array.isArray(cfg.worktreeCopy) ? cfg.worktreeCopy : []);
    const candidates = ['local.properties', '.env', 'gradle.properties', 'debug.keystore', 'keystore.properties']
      .filter(f => existsSync(join(repoPath, f)) && !copies.has(f));
    if (candidates.length) {
      let tracked = [];
      try { tracked = execFileSync('git', ['ls-files', '--', ...candidates],
        { cwd: repoPath, encoding: 'utf8', timeout: 10_000, windowsHide: true }).split('\n').filter(Boolean); } catch {}
      const orphans = candidates.filter(f => !tracked.includes(f));
      if (orphans.length) add(false, 'build config reaches the worktree',
        `${orphans.join(', ')} exist here but are untracked: a run's fresh worktree will not have them`,
        'name them in "worktreeCopy" in .autodev.json so kickoff copies them into the worktree', 'warn');
    }
  }

  // The runner reads .autodev.json from the WORKTREE, and a worktree checkout is tracked
  // files only: a config that is untracked (or edited but uncommitted) here is not the
  // config the run obeys. maxCostUsd in that gap is an UNENFORCED cost cap.
  const cfgFile = join(repoPath, '.autodev.json');
  if (head && existsSync(cfgFile)) {
    let reaches = false;
    try { execFileSync('git', ['ls-files', '--error-unmatch', '--', '.autodev.json'],
      { cwd: repoPath, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000, windowsHide: true }); reaches = true; } catch {}
    let st = '';
    try { st = execFileSync('git', ['status', '--porcelain', '--', '.autodev.json'],
      { cwd: repoPath, encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim(); } catch {}
    const why = !reaches
      ? 'untracked: a run reads the worktree copy, which will not have it (maxCostUsd/push/testCmd silently ignored)'
      : st ? 'differs from HEAD: a run reads the committed version, not this working copy' : null;
    add(!why, '.autodev.json reaches the run', why ?? 'committed and clean',
      'commit .autodev.json so the run worktree contains it', 'warn');
    let bad = null;
    try { JSON.parse(readFileSync(cfgFile, 'utf8')); } catch (e) { bad = e.message; }
    add(!bad, '.autodev.json parses', bad ? `${bad}; repoConfig() swallows this and the run proceeds on {}` : 'valid JSON',
      'fix the JSON; a malformed config is silently treated as empty', 'warn');
  }

  const explicit = repoConfig(repoPath).testCmd;
  const detected = (explicit || !head) ? null : detectTestCmd(repoPath);
  const testCmd = explicit || detected;
  add(!!testCmd, 'test command detectable',
    testCmd ? `${testCmd} ${explicit ? '(testCmd in .autodev.json)' : '(detected: pin it with "testCmd" in .autodev.json)'}` : 'none found',
    'pass --test-cmd "<cmd>" or set "testCmd" in .autodev.json; the Test stage parks without one', 'warn');
  // ponytail: both heuristics below second-guess only a DETECTED command; an explicit
  // testCmd is the operator's own answer.
  if (detected?.startsWith('cd ')) {
    const subs = markerSubdirs(repoPath);
    if (subs.length > 1) add(false, 'test command unambiguous',
      `test markers in ${subs.length} subprojects (${subs.join(', ')}); detection runs only the first`,
      'set "testCmd" in .autodev.json to the command that runs the whole suite', 'warn');
  }
  // Match the tool token, not the whole string: the cd-form's interpolated path can itself
  // contain "gradle" or "mvn" (e.g. a repo checked out under a gradle-named directory) and
  // /gradle|mvn/.test(detected) would false-positive on an npm/pytest/etc. subproject there.
  const tool = detected ? detected.replace(/^cd\s+"[^"]*"\s+&&\s+/, '') : '';
  if (detected && /^(?:\.[\\/])?(?:gradlew(?:\.bat)?|gradle|mvn)\b/.test(tool) && !hasTestSources(repoPath))
    add(false, 'detected test suite is non-vacuous',
      `${detected} finds no test sources (no src/*test*): it exits 0 having run nothing`,
      'write tests, or set "testCmd" to a command that fails when nothing ran', 'warn');

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
