# Implementation Plan: First Green Run

**Branch**: `spec/first-green-run` | **Date**: 2026-08-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-first-green-run/spec.md`

## Summary

Five changes, all inside the existing execution path, that make a parked run diagnosable, stop
unrecoverable failures after one paid session, guarantee the runner actually starts, carry a
park's diagnosis into its resume, and pin each run to the spec directory it actually owns.

The load-bearing change is a `try`/`catch` around the existing `execFileSync` call in
`runClaude`. Measurement (research R1) showed the exec mechanism does not need replacing: on a
non-zero exit, Node attaches **both** `e.stdout` and `e.stderr` to the thrown error, and on
`ENOENT` / `ETIMEDOUT` / `ENOBUFS` it sets `e.code` and produces a message that does *not* echo
argv. The only broken case is the ordinary non-zero exit, whose `Error.message` is
unconditionally `Command failed: <full argv>` — and `argv[2]` is the stage prompt. Today nothing
catches it, so that string escapes as the run's diagnosis.

So the fix is to catch it and throw a replacement built from what the session actually produced.
No change of exec primitive, and — critically — no loss of the live stderr forwarding that
`execFileSync` performs by default, which an earlier draft of this plan would have traded away
by moving to `spawnSync`. The diff is smaller than the trade-off version and strictly better.

Everything else is small and local: three classifiers (one structural, two textual) setting the
`e.final` flag the retry loop already honors, four `'node'` → `process.execPath` substitutions, a
five-line seed of the existing `lastErr` splice on the resume path, and one nullable `spec_dir`
column consulted by a single new resolver.

## Technical Context

**Language/Version**: JavaScript (ESM, `"type": "module"`), Node ≥22.5 — required for
`node:sqlite`

**Primary Dependencies**: none. Node standard library only: `node:sqlite`, `node:child_process`,
`node:fs`, `node:http`, `node:path`, `node:crypto`, `node:os`. Constitution Principle I forbids
adding any.

**Storage**: SQLite registry at `$AUTODEV_HOME/autodev.db` (single `runs` table) plus append-only
`$AUTODEV_HOME/runs/<id>/events.jsonl`. Per-run `runner.log` and `blocked.md` are derived
artifacts, not state.

**Testing**: `node --test --test-timeout=120000`. Existing helpers in `test/helpers.js`; headless
sessions stubbed through `AUTODEV_CLAUDE_BIN` pointing at a `.js` file, which the runner detects
and executes via `process.execPath`. No test spends quota or touches the network.

**Target Platform**: Linux, macOS, Windows — CI matrix runs all three on Node 22 and 24.

**Project Type**: single-project CLI plus a local HTTP/SSE dashboard server.

**Performance Goals**: not latency-bound. The only budget that matters is paid sessions: a
terminal failure must cost one session instead of three.

**Constraints**: no new runtime dependency; no third state store; no new HTTP route; no new CLI
command; no new configuration key; no public egress; every new database column nullable and
tolerant of rows written by an older binary.

**Scale/Scope**: ~823 lines of `src/`, ~1030 lines of `test/`. This change touches 5 source files,
adds 1 small module, and adds ~20 test cases. Estimated net addition ≈ 120 lines of source.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes recorded.*

| Principle | Gate | Pre-design | Post-design |
|---|---|---|---|
| I. Zero runtime dependencies | No new entry under `dependencies`; stdlib only | PASS — `spawnSync` is `node:child_process` | PASS |
| II. One source of truth | No third state store; nothing derived from a file the DB points at; server stays optional | PASS — `spec_dir` holds a repo-relative path resolved against the worktree, not a pointer to a file that carries state | PASS |
| III. Gates are artifacts | No stage advances on self-report; new gates observe disk | PASS — no gate semantics change; stage checks read the same artifacts, only the directory they read them from is pinned | PASS |
| IV. Failure legible and recoverable | Park reason worth reading; terminal failures park on first attempt; resume carries the diagnosis | PASS — this principle *is* the feature | PASS |
| V. One precedence chain | New settings slot into CLI > `.autodev.json` > env > default | PASS — no new setting is introduced | PASS |
| VI. Three platforms, proven | No POSIX-only mechanism without a `win32` branch; `process.execPath` for Node children; `node:test` coverage; offline | PASS — the `process.execPath` substitution is itself a Principle VI fix; `spawnSync` is cross-platform | PASS |
| VII. Least surface | No public egress, no widened HTTP surface, no new prompt-influencing endpoint; on-disk model output bounded and minimal | PASS — nothing is served over HTTP; retained output is failing attempts only, size-capped, and lands in the existing `runner.log` | PASS |

**Result: PASS, no violations.** Complexity Tracking is therefore omitted.

Two design decisions deserve explicit note against the constitution rather than silence:

- **A new module, `src/session.js`, is added** despite research recommending the classifier be
  written inline. `src/runner.js` is a top-level script with side effects — it opens the
  database, reads `process.argv`, and begins executing on import — so nothing in it can be
  imported by a test. Pure, testable helpers must live somewhere importable. The module is
  stateless: three functions, no I/O, no state. It does not become a second source of truth
  (Principle II) because it stores nothing.
- **Live stderr forwarding is preserved.** An earlier draft proposed `spawnSync` with piped
  stdio, which would have ended the default forwarding of a session's stderr into `runner.log`
  and traded a live signal for a post-mortem one. Measurement removed the trade entirely
  (research R1/R2): `execFileSync` already both forwards stderr to the parent *and* attaches it
  to the thrown error. Nothing is given up.

## Project Structure

### Documentation (this feature)

```text
specs/001-first-green-run/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0: decisions and rejected alternatives
├── data-model.md        # Phase 1: run record, session block, park record
├── quickstart.md        # Phase 1: how to prove each story end to end
├── contracts/
│   ├── run-record.md           # runs table contract + spec_dir semantics
│   ├── park-reason.md          # what blocked_reason may and may not contain
│   ├── session-log.md          # runner.log session block format
│   └── terminal-conditions.md  # the enumerated terminal failure set
├── checklists/
│   └── requirements.md  # Spec quality checklist (complete)
└── tasks.md             # Phase 2 output — created by /speckit-tasks, not here
```

### Source Code (repository root)

```text
src/
├── session.js       # NEW — causeLine(), classify(), sessionBlock(); pure, no I/O
├── runner.js        # runClaude rewritten on spawnSync; resume seeds lastErr; records spec_dir
├── stages.js        # NEW per-run spec dir resolver; specFile + stage 2/3/4 checks and prompts use it
├── db.js            # spec_dir column: CREATE TABLE, migration loop, createRun
├── server.js        # process.execPath ×2; tasksFor uses the shared resolver
├── config.js        # unchanged
├── events.js        # unchanged
├── metrics.js       # unchanged
├── jira.js          # unchanged
├── doctor.js        # unchanged (no auth probe — see research R5)
└── selftest.js      # unchanged; must stay green as the regression canary

bin/
├── autodev.js       # process.execPath ×2; persists the adopted spec dir
└── hook-emit.js     # unchanged

test/
├── session.test.js  # NEW — unit tests for the three pure helpers
├── runner.test.js   # park reason, classification, resume seeding, spec_dir recording
├── db.test.js       # spec_dir migration and round-trip
├── stages.test.js   # resolver precedence and fallback
├── cli.test.js      # spec_dir persisted on --spec and on auto-match
└── helpers.js       # extended with a stub factory that fails with chosen output
```

**Structure Decision**: single project, existing layout, no new directory. Every change lands in
a file that already exists except `src/session.js` and `test/session.test.js`. The layout is
dictated by the repository as it stands; this feature has no cause to reshape it.

## Phase 0 — Research

Complete. See [research.md](./research.md). Seven decisions recorded (R1–R7), each with the
alternatives rejected and why. No `NEEDS CLARIFICATION` markers remained after the spec's
clarification round, so Phase 0 resolved implementation mechanism rather than open questions.

## Phase 1 — Design & Contracts

Complete. Artifacts:

- [data-model.md](./data-model.md) — the `runs` row after this change, the session block written
  to `runner.log`, and the park record; state transitions for a run across park and resume.
- [contracts/run-record.md](./contracts/run-record.md) — `spec_dir` semantics, nullability,
  migration behavior, and the resolution order every consumer must follow.
- [contracts/park-reason.md](./contracts/park-reason.md) — the invariant that makes SC-001
  checkable: what `blocked_reason` must contain and what it must never contain.
- [contracts/session-log.md](./contracts/session-log.md) — the block appended to `runner.log`
  for a failing attempt, including its size cap.
- [contracts/terminal-conditions.md](./contracts/terminal-conditions.md) — the enumerated set,
  each condition's detection basis, its remedy text, and the fail-open rule.
- [quickstart.md](./quickstart.md) — runnable validation for each of the five user stories,
  plus the end-to-end run that satisfies SC-008.

## Implementation Notes

Ordering is dictated by dependency, not by priority: US3 (`process.execPath`) must land first,
because on an affected machine nothing else can be observed at all.

1. **`process.execPath`** — `bin/autodev.js` `ensureServer` and `spawnRunner`; `src/server.js`
   jump and skip relaunches. Four call sites, one substitution each. Ship first, alone.
2. **`src/session.js`** — `causeLine`, `classify`, `sessionBlock`. Pure; fully unit-testable
   before anything consumes it.
3. **`runClaude` catches and re-throws** — wrap the existing `execFileSync` call, raise
   `maxBuffer`, build the replacement message from `causeLine(e.stdout + e.stderr)`, append the
   session block to `runner.log` on failure only, attach `final` when `classify` returns a match.
   The exec primitive, its options, and its success path are otherwise untouched.
4. **Resume seeding** — capture `run.blocked_reason` before the resume path nulls it; seed the
   per-stage `lastErr` for the first attempt of the resumed stage only.
5. **`spec_dir`** — column, persistence at kickoff and after stage 1, one resolver, and every
   consumer switched to it.

Steps 1 and 5 are independent bug fixes with their own user stories and should be separate
commits from steps 2–4, per the constitution's "bug fixes ship separately from features" rule.

## Risks

- **Classification false positives.** A regex matching a phrase the model merely quoted would
  park a recoverable run. Mitigated structurally: classification runs only on a *failed* session
  (FR-012), the set is three narrow conditions, and matching is anchored to phrases that appear
  in tool error output rather than prose. `ENOENT` is detected structurally, not by regex.
- **Successful sessions still discard stderr.** `execFileSync` attaches both channels only to a
  thrown error; on success stderr is forwarded to `runner.log` but not returned. That is
  compatible with FR-025 (retain failing attempts only) and is why the retention decision and
  the exec mechanism fit each other. If retaining successful sessions is ever wanted, it becomes
  a real change of primitive, not a flag.
- **`spec_dir` drift.** A recorded directory that no longer exists in the worktree must fall
  back rather than fail (FR-023). This is the most likely shipping bug in the change; it is
  covered by an explicit test rather than a code comment.
- **`maxBuffer` still finite.** Raising the cap does not remove it. A session exceeding even the
  raised cap now fails with a message naming the overflow, which is a large improvement on
  today's opaque failure but is still a park.
