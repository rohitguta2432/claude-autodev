# Changelog

## Unreleased — the factory release

Four things stood between "an autonomous pipeline" and "a repository that ships
its own code": nothing could refuse work, nothing checked the build against
criteria the builder hadn't written, nothing merged or deployed, and nothing
pulled the next job. All four are here.

### Added
- **Holdout scenarios.** The spec stage now writes end-to-end acceptance
  scenarios; the runner moves them out of the worktree and into
  `.git/info/exclude` the moment the spec gate passes, so no later session can
  read them from the tree *or* the history. They come back for one session — the
  acceptance check at the end of stage 7 — and a failure is fed to the builder as
  what was *observed*, never as the scenario. A green builder-written suite is no
  longer enough to finish a run.
- **Mission and factory rules** (`autodev init`). `.autodev/mission.md` lets the
  spec stage return `REJECT` and end the run as `REJECTED` before any code
  exists — the first mechanism autodev has for telling the operator no.
  `.autodev/factory-rules.md` is prepended to every session in the run: the
  constraints that bind work nobody is watching, kept separate from the
  `CLAUDE.md` that governs work you are.
- **Stage 8, Deploy** — opt-in via `"deploy"` in `.autodev.json`. Merges the run's
  PR and runs a deploy command from the main repo path. Deliberately not agentic:
  it parks on failure rather than handing an unsupervised session a broken
  production deploy.
- **`autodev daemon`** — reconcile finished runs onto their issues, dispatch
  `autodev:accepted` issues up to `--max-parallel`, and (only with
  `--auto-accept`) label new ones. Concurrency is read from the run registry, so
  the daemon is safe to restart mid-tick.
- **`autodev run --issue <n>`** takes the requirement from a GitHub issue and
  records the mapping the daemon reconciles against.

- **Proof of shipping.** The runner keeps each gate's artifact under
  `runs/<id>/proof/` and records `merged`, `deployed` and `proof` events; the
  deploy stage skips an already-merged PR on resume and accepts a `proofCmd`
  that must leave evidence behind. The Jira queue closes a ticket by attaching
  that evidence, posting a comment derived from the event log, and only then
  transitioning — and says "not deployed by autodev" when nothing was.
  (specs/002-proof-of-shipping)

- **`effort` / `stageEffort`** in `.autodev.json` and `AUTODEV_CLAUDE_EFFORT`,
  passed to every session as `--effort`. (specs/003)

### Changed
- Every stage session now defaults to `claude-opus-5` at `--effort max` instead
  of the `claude` CLI's own default model and effort. (specs/003)

- Stage count is now per repo: 7 without a deploy config, 8 with one. `autodev
  status` and the dashboard's skip-to-finish both read the repo's own pipeline
  rather than a global constant.
- The draft PR is marked ready at the end of stage 7 instead of after the run, so
  the deploy stage has a non-draft PR to merge.

### Removed
- `maxCostUsd`. A run is no longer parked on accumulated spend; `autodev cost`
  and the per-stage metrics remain the readout. (specs/003)

## Earlier — first green run

The first-green-run release: everything here exists because the pipeline had
never completed a run, and the one run it had recorded could not be diagnosed.

### Fixed
- **A parked run reported the stage prompt as its diagnosis.** `execFileSync`'s
  message for a non-zero exit is `Command failed: <argv>`, and `argv[2]` is the
  prompt — so the echo reached `blocked.md`, `blocked_reason`, both retry
  events, `autodev status` and the dashboard at once, while the real cause
  survived only inside the last-output block. The reason is now built from what
  the session actually produced.
- **Background processes were launched by asking `PATH` for `node`.** Where
  `PATH` has none, or one older than the 22.5 that `node:sqlite` needs, the
  detached runner died into `runner.log` and the run row stayed `RUNNING`
  forever — no park, no event. Now `process.execPath` everywhere.
- **`--spec` was discarded after kickoff.** Every stage re-resolved "the spec"
  as the highest-numbered `specs/NNN-*`, so a repo with several specs had its
  later stages work one the operator never chose — and report success for it.
  Runs are now pinned to a `spec_dir`, resolved through a single function.
- `maxBuffer` raised to 64 MiB. The 1 MiB default against a 45-minute session
  under `--output-format json` killed the child with `SIGTERM` and parked the
  run for a reason unrelated to the work.
- Resume no longer discards what it learned: the park reason is read before it
  is cleared, and seeded into the resumed stage's first attempt.

### Added
- Terminal-failure classification. A signed-out CLI, a missing binary, or an
  exhausted usage allowance now parks on the **first** attempt with its remedy,
  instead of buying the same impossible session three times. Classification
  runs only on a session that failed, and anything unrecognised keeps the
  existing retry budget — a rate limit is deliberately not in the set.
- Failing sessions leave an attributed, size-capped block in the run's existing
  `runner.log`. Successful sessions leave nothing: a run makes 10–25 sessions
  and only the failing one gets read.

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
