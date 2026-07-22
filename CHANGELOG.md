# Changelog

## v0.2.0 — 2026-07-22

The cold-start hardening release: a stranger on a fresh machine (Linux, macOS,
or Windows) can install, prove the install, and run — without forking,
patching, or asking the author anything.

### Fixed
- **Install blocker**: `src/jira.js` + `src/server.js` were gitignored as
  local-only but statically imported by the CLI — every command died with
  `ERR_MODULE_NOT_FOUND` on a fresh install. Both (sanitized, env-driven) now ship.
- Windows: `npm test` glob, bash-only test fixtures, extensionless stubs, and
  `autodev stop` leaving the claude child alive (`taskkill /T` now).
- Docs said 6 stages; the pipeline has 7 (Verify was undocumented).
- Test stage silently passed when no test command was detected — it now parks
  with remediation.

### Security
- Dashboard mutating endpoints: cross-origin POSTs rejected
  (Origin/Sec-Fetch-Site), per-session token required from browser contexts,
  Host allowlist against DNS rebinding.
- One-time informed consent for `--dangerously-skip-permissions`, with the
  worktree-isolation limits stated honestly.

### Added
- `autodev selftest` — all 7 stages against a fixture repo in seconds, zero quota.
- `autodev doctor` — 10 preflight checks with per-check remediation; auto-runs
  before `run`.
- `autodev cost <id>` — per-stage sessions/tokens/$; `maxCostUsd` ceiling parks
  over-budget runs; per-stage model selection (`stageModels`/`model`/
  `AUTODEV_CLAUDE_MODEL`).
- `--until <stage>`, `--no-push`, `--test-cmd`; per-repo `.autodev.json`
  (documented precedence: CLI > config > env > default).
- Draft PR at Push, marked ready only after Review + Test pass.
- Test detection: gradle, tox, requirements+tests/, Makefile test target,
  .csproj/.sln, and a one-level subdir scan.
- `install-skill --project` / `--force`, `uninstall-skill`; packaged spec skill
  renamed `autodev-specs` (was the collision-prone `specs-skill`).
- CI on ubuntu/macos/windows × Node 22/24.

## v0.1.0 — 2026-07-19

Initial release: 7-stage pipeline (spec → analyze → implement → verify → push →
review → test) in an isolated git worktree, SQLite + JSONL state, live SSE
dashboard, Jira-driven runs, per-stage skip/jump.
