---
description: "Task list for First Green Run"
---

# Tasks: First Green Run

**Input**: Design documents from `/specs/001-first-green-run/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **mandatory**. The constitution requires tests with the change, not after
(Development Workflow), and each contract carries explicit test obligations. Every story below
ships with them.

**Organization**: grouped by user story so each can be implemented, tested, and committed on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different file, no dependency on an incomplete task
- **[Story]**: the user story from [spec.md](./spec.md) this task serves

## Path Conventions

Single project, existing layout: `src/`, `bin/`, `test/` at the repository root.

---

## Phase 1: Setup (Shared Test Infrastructure)

**Purpose**: the fixtures every story's tests need. No production code.

- [ ] T001 [P] Add `stubFailing({ stdout, stderr, exit, recordTo })` to `test/helpers.js` — writes
      a CommonJS Node stub that prints the given output and exits with the given code, and
      appends each invocation (its argv and the prompt it received) to `recordTo` so a test can
      assert **session count** and **prompt content**, not just the final reason.
- [ ] T002 [P] Add `repoWithSpecs(dir, names)` to `test/helpers.js` — builds a git fixture repo
      containing several complete `specs/NNN-*` directories (non-empty `spec.md`, `plan.md`,
      `tasks.md`), for the US5 resolution tests.

**Checkpoint**: fixtures exist; `npm test` still green.

---

## Phase 2: Foundational (Blocking Prerequisites for US1 and US2)

**Purpose**: the pure, stateless helpers. No I/O, no state — see research R7 for why they live in
their own module rather than inline in `src/runner.js`.

**⚠️ Blocks US1 and US2 only.** US3, US4 and US5 are independent of this phase and may proceed
in parallel with it.

- [ ] T003 Create `src/session.js` exporting `causeLine(text)` — last lines carrying content,
      blank and decorative lines skipped, whitespace collapsed, sliced to 300 characters, per
      [contracts/park-reason.md](./contracts/park-reason.md).
- [ ] T004 Add `classify({ code, out })` to `src/session.js` — the three enumerated conditions in
      fixed order (`ENOENT` structural first, then not-authenticated, then allowance-exhausted),
      returning `{ code, reason, fix }` or `null`, per
      [contracts/terminal-conditions.md](./contracts/terminal-conditions.md). Rate limiting is
      deliberately excluded.
- [ ] T005 Add `sessionBlock({ run, stage, title, attempt, outcome, ms, classified, stdout, stderr })`
      to `src/session.js` — returns the delimited string of
      [contracts/session-log.md](./contracts/session-log.md), each channel clamped to 1 MiB
      (first 200 KiB + elision marker + last 800 KiB), empty sections omitted. Returns a string;
      writes nothing.
- [ ] T006 [P] Create `test/session.test.js` — unit tests for all three helpers: `causeLine` on
      empty/whitespace-only/multi-line input and on input longer than the cap; `classify` on each
      condition, on a non-match, and on a two-condition collision; `sessionBlock` clamping and
      section omission.

**Checkpoint**: helpers exist and are proven in isolation before anything consumes them.

---

## Phase 3: User Story 3 — The runner starts on every supported machine (Priority: P1) 🎯 Ship first

**Goal**: no background process is launched via a bare interpreter name resolved from `PATH`.

**Independent Test**: on a machine whose `PATH` offers no suitable interpreter, a run advances
past stage 1 instead of sitting `RUNNING` forever.

**Why first**: on an affected machine nothing else in this feature can even be observed. This is
a standalone bug fix and lands as its own commit, per the constitution's "bug fixes ship
separately from features" rule.

### Tests for User Story 3

- [x] T007 [P] [US3] Add a guard test in `test/cli.test.js` asserting no `spawn('node'` or
      `spawn("node"` literal remains under `src/` or `bin/` — the regression is silent, so the
      assertion is structural.
- [x] T008 [P] [US3] Add a test in `test/runner.test.js` that launches a run with a `PATH`
      containing no `node` and asserts the run leaves stage 1.

### Implementation for User Story 3

- [x] T009 [US3] Replace `'node'` with `process.execPath` in `ensureServer` in `bin/autodev.js`.
- [x] T010 [US3] Replace `'node'` with `process.execPath` in `spawnRunner` in `bin/autodev.js`.
- [x] T011 [P] [US3] Replace `'node'` with `process.execPath` in both runner relaunches in
      `src/server.js` — the jump handler and the skip handler.

**Checkpoint**: a run starts and advances regardless of what `PATH` offers. Commit.

---

## Phase 4: User Story 1 — A parked run states the real failure (Priority: P1)

**Goal**: `blocked_reason` describes what went wrong; the failing session's output is retained,
attributed, and readable from the run directory.

**Independent Test**: force a session to fail with a known message; the run's reason contains
that message and no part of the stage prompt.

### Tests for User Story 1

- [ ] T012 [P] [US1] `test/runner.test.js`: a failing session's `blocked_reason` contains the
      stub's message, and contains **no** non-trivial substring of the stage prompt — the
      mechanical form of SC-001.
- [ ] T013 [P] [US1] `test/runner.test.js`: both `retry` events for a failing stage carry the
      real reason, not the prompt; `blocked.md`'s last-output block contains text the stub wrote
      to **stderr** as well as stdout.
- [ ] T014 [P] [US1] `test/runner.test.js`: `runner.log` contains a session block matching
      [contracts/session-log.md](./contracts/session-log.md), headed with the correct stage and
      attempt number; a **successful** session leaves no block (FR-025).
- [ ] T015 [P] [US1] `test/runner.test.js`: a session emitting more than 1 MiB of output
      completes normally rather than parking (the raised buffer), and a session emitting far more
      than the block cap produces a clamped block with an elision marker.

### Implementation for User Story 1

- [ ] T016 [US1] Wrap the `execFileSync` call in `runClaude` (`src/runner.js`) in `try`/`catch`.
      In the catch, build a replacement `Error` whose message is `causeLine(stdout + stderr)`,
      falling back to the stage, attempt and exit status when both channels are empty. **Do not
      specify `stdio`** — the default forwarding is what keeps session stderr streaming live into
      `runner.log` (research R2). Pass through the already-meaningful `ENOENT`/`ETIMEDOUT`/`ENOBUFS`
      messages rather than replacing them.
- [ ] T017 [US1] Raise `maxBuffer` to 64 MiB on the same `execFileSync` options in `src/runner.js`
      — the default 1 MiB against a 45-minute `--output-format json` session is a live latent
      bug (research R1).
- [ ] T018 [US1] In the same catch, append `sessionBlock(...)` to
      `$AUTODEV_HOME/runs/<id>/runner.log`, wrapped so that a write failure is swallowed and
      cannot change whether the run advances or parks (FR-007).
- [ ] T019 [US1] In the stage loop's catch in `src/runner.js`, set `lastOut` from
      `e.stdout` **and** `e.stderr` rather than stdout alone, so `park()`'s last-output block
      carries both channels.

**Checkpoint**: park a run deliberately and diagnose it from `blocked.md` alone.

---

## Phase 5: User Story 2 — An unrecoverable failure stops after one session (Priority: P1)

**Goal**: the three enumerated terminal conditions park on the first attempt with their remedy.

**Independent Test**: force each condition; exactly one session is spent.

### Tests for User Story 2

- [ ] T020 [P] [US2] `test/runner.test.js`: each of the three conditions produces **exactly one**
      recorded session — asserted by counting invocations in the stub's record file, not by
      reading the reason — and the reason names the remedy.
- [ ] T021 [P] [US2] `test/runner.test.js`: an unmatched failure still makes the full complement
      of attempts (fail-open, FR-011); a session that exits **zero** while printing a matching
      phrase neither parks nor classifies (FR-012); two conditions present at once resolve to the
      earlier one in the fixed order.

### Implementation for User Story 2

- [ ] T022 [US2] In `runClaude`'s catch in `src/runner.js`, call `classify({ code: e.code, out })`
      and, on a match, attach the existing `final` flag to the thrown error and fold the remedy
      into its message. No new control flow — the stage loop already honors `final`.

**Checkpoint**: a signed-out CLI costs one session, not three. Commit Phases 2, 4 and 5 together
as the park-forensics change.

---

## Phase 6: User Story 4 — A resumed stage knows what failed last time (Priority: P2)

**Goal**: the recorded park reason reaches the first attempt of the resumed stage.

**Independent Test**: park, resume, and confirm the resumed session's prompt carries the reason.

### Tests for User Story 4

- [ ] T023 [P] [US4] `test/runner.test.js`: after a park-then-resume, the prompt recorded by the
      stub contains the previous reason; a resume of a never-parked run contains no
      previous-failure text; two consecutive resumes carry one reason, not two concatenated; and
      a seeded attempt that succeeds makes no further attempts.

### Implementation for User Story 4

- [ ] T024 [US4] In `src/runner.js`, capture `run.blocked_reason` into a local **before** the
      resume branch calls `saveState({ status: 'RUNNING', blocked_reason: null })`.
- [ ] T025 [US4] Seed the stage loop's `lastErr` from that captured value for the **first attempt
      of the resumed stage only**, so the existing "A previous attempt failed its verification:"
      splice fires. Consume the seed once — `lastErr` is already re-declared per stage, which
      satisfies "must not persist into later stages" (FR-017) for free.

**Checkpoint**: resume is meaningfully different from retry.

---

## Phase 7: User Story 5 — The run works the spec it was given (Priority: P2)

**Goal**: each run is pinned to the spec directory it owns, and every consumer resolves through
one function.

**Independent Test**: in a repository holding several complete specs, adopt a lower-numbered one
and confirm every later stage operates on it.

### Tests for User Story 5

- [ ] T026 [P] [US5] `test/db.test.js`: `spec_dir` round-trips; a database created without the
      column opens, migrates, and reads unchanged.
- [ ] T027 [P] [US5] `test/stages.test.js`: the resolver returns the pinned directory when it
      exists; falls back to highest-numbered when `spec_dir` is `NULL`; falls back — rather than
      throwing or parking — when the pinned directory is absent from the worktree (FR-023).
- [ ] T028 [P] [US5] `test/cli.test.js`: an explicitly chosen spec and an automatically matched
      spec both persist `spec_dir`; the stored value is repo-relative and POSIX-form on every
      platform.
- [ ] T029 [P] [US5] `test/runner.test.js`: using `repoWithSpecs`, a run adopting `001` has
      stages 2–4 read `001` and not the highest-numbered directory; a fresh run records what its
      stage 1 created.

### Implementation for User Story 5

- [ ] T030 [US5] Add `spec_dir TEXT` to `src/db.js` — the `CREATE TABLE` statement, the
      `ALTER TABLE … ADD COLUMN` migration loop, and `createRun`'s column and value lists.
- [ ] T031 [US5] Add the shared resolver to `src/stages.js` implementing the resolution contract
      in [contracts/run-record.md](./contracts/run-record.md), including the mandatory fallback.
      Export it.
- [ ] T032 [US5] Switch `specFile` and the stage 1–4 checks in `src/stages.js` to the resolver.
      No consumer may re-implement it.
- [ ] T033 [US5] Change the stage 2, 3 and 4 prompts in `src/stages.js` to name the resolved
      directory instead of instructing the session to find "the newest" one (FR-022) — otherwise
      the session and the check that grades it can disagree.
- [ ] T034 [US5] In `bin/autodev.js`, pass the already-computed adopted spec path into
      `createRun` so it is persisted rather than only printed.
- [ ] T035 [US5] In `src/runner.js`, after stage 1's check passes and only when the column is
      still `NULL`, record the directory that stage created — resolved from the worktree by the
      runner, never reported by the session.
- [ ] T036 [P] [US5] Switch `tasksFor` in `src/server.js` to the shared resolver so the
      dashboard's task pane shows the run's own spec.

**Checkpoint**: all five stories independently functional.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T037 [P] Update the Troubleshooting table in `README.md`: the three terminal conditions and
      what they now say, and a line stating that a failing session's output is retained in
      `runner.log`.
- [ ] T038 [P] Add a `CHANGELOG.md` entry describing the park-reason fix, terminal classification,
      the interpreter fix, resume seeding, and spec pinning.
- [ ] T039 Run `autodev selftest` — it must stay green. It is the canary for the exec path; a
      break here means `runClaude`'s **success** path changed when only its failure path should
      have.
- [ ] T040 Walk [quickstart.md](./quickstart.md) end to end, including the manual SC-002
      read-through that no test can perform.
- [ ] T041 **SC-008** — complete one real green run against a small real repository with
      `--no-push`. Record what happened. If it parks, the park reason is now the evidence, and it
      is also the only admissible basis for ever adding a fourth terminal condition.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: blocks **US1 and US2 only**. US3, US4 and US5 do not depend on it
  and may run in parallel — stated plainly rather than pretending a universal barrier exists.
- **Phase 3 (US3)**: independent. Ship first anyway — on an affected machine nothing else is
  observable.
- **Phase 4 (US1)**: needs T003 and T005.
- **Phase 5 (US2)**: needs T004 and, in practice, T016 (both edit `runClaude`'s catch).
- **Phase 6 (US4)**: independent of Phases 2, 4, 5 and 7.
- **Phase 7 (US5)**: independent; T030 → T031 → {T032, T033} and T034/T035 after T030.
- **Phase 8 (Polish)**: after every story it documents.

### Commit grouping

Three commits, per the constitution's separation rule:

1. **fix**: Phase 3 — interpreter resolution (US3).
2. **feat**: Phases 2, 4, 5, 6 — park forensics, classification, resume seeding.
3. **fix**: Phase 7 — spec pinning (US5).

Phase 8 rides with whichever commit it documents, except T039–T041, which are validation.

### Parallel opportunities

- T001 and T002 together.
- T007, T008 with T009–T011 (tests are structural and can be written first).
- All of T012–T015 together; all of T020–T021 together; all of T026–T029 together.
- Phases 3, 6 and 7 can proceed simultaneously with Phase 2.

---

## Parallel Example: User Story 1

```bash
# Write the four assertions first — they fail until T016-T019 land:
Task: "blocked_reason contains the stub message and no prompt substring (test/runner.test.js)"
Task: "retry events and blocked.md carry both channels (test/runner.test.js)"
Task: "runner.log session block is attributed; success writes nothing (test/runner.test.js)"
Task: "oversized session output completes; block is clamped (test/runner.test.js)"
```

---

## Implementation Strategy

### Ship first: US3 alone

`process.execPath`, four call sites, two tests. Small enough to land and verify in one sitting,
and it is the precondition for observing anything else on an affected machine.

### Then: the park-forensics increment (Phase 2 + US1 + US2)

This is the feature proper. It is worth landing as one commit because the classifier and the
message construction share the same catch block, and splitting them would build the same seam
twice.

### Then: US4, then US5

Both independent, both small, both improvements to correctness rather than to diagnosis.

### Finally: prove it

T041 is the point of the whole change set. Every other task exists so that the first real run
either succeeds or explains itself.

---

## Notes

- `[P]` = different file, no dependency on an incomplete task.
- Every task names a real file that exists today, except `src/session.js` and
  `test/session.test.js`.
- Commit after each phase; stop at any checkpoint to validate a story on its own.
- No task adds a runtime dependency, a configuration key, a CLI command, or an HTTP route. If one
  appears to require any of those, the design is wrong — re-read the Constitution Check in
  [plan.md](./plan.md) before proceeding.
