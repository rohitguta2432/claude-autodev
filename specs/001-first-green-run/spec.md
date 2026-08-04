# Feature Specification: First Green Run

**Feature Branch**: `spec/first-green-run`

**Created**: 2026-08-03

**Status**: Draft

**Input**: User description: "The 'first green run' change set: honest park reason, terminal-failure classification, session stderr capture into the run log, large-output tolerance, resume that carries the previous diagnosis forward, the chosen spec directory pinned to the run, and the runner spawned with the interpreter that is actually running."

## Context

claude-autodev has never completed a run. The only run ever recorded on the author's machine
parked at stage 1, five seconds in, and the diagnosis it handed back was a truncated copy of the
instruction the pipeline had just given the model — not the reason the session failed. The real
cause was recoverable in seconds once known.

This feature is not a new capability. It is the set of changes that make the pipeline's existing
promise — *requirement in, reviewed and tested PR out, parks with a diagnosis when it truly gets
stuck* — true for the first time. Every item below was selected because it either blocks a run
from starting, blocks an operator from diagnosing why one stopped, or silently makes a run do
work nobody asked for.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A parked run states the real failure (Priority: P1)

An operator starts a run, walks away, and comes back to a `BLOCKED` status. They want one line
that names what went wrong, and — if that line is not enough — evidence in the run's own
directory that explains it, without opening the worktree or reconstructing the session.

Today the stated reason is the pipeline's own stage instruction, because the underlying failure
is reported as "the command failed" with the whole invocation attached, and the invocation
carries the prompt. The same string reaches the blocked file, the status listing, the parked
event, and the dashboard, so every surface is equally uninformative at once. Output written to
the session's error channel is not retained anywhere attributable.

**Why this priority**: It is the difference between a five-second fix and an archaeology
session, and it is the precondition for every other recovery behavior in this set — an operator
cannot steer a resume, act on a notification, or trust a gate whose failure they cannot read.

**Independent Test**: Force a session to fail with a known message. Confirm the run's stated
reason names that message and does not contain the stage instruction, and that the failing
session's output is retrievable from the run's directory afterward.

**Acceptance Scenarios**:

1. **Given** a stage session that exits non-zero after printing a diagnosable message,
   **When** the run parks, **Then** the stated reason is drawn from the end of that session's
   output and contains no part of the instruction the session was given.
2. **Given** the same failure, **When** the operator opens the run's directory,
   **Then** the failing session's output — including anything written to the error channel — is
   present, attributed to the stage and attempt that produced it.
3. **Given** a stage that fails and is retried, **When** the operator reads the run's activity
   history, **Then** each retry is described by what actually failed, not by what was asked.
4. **Given** a session that produces an unusually large amount of output, **When** it completes,
   **Then** the run continues normally rather than failing for a reason unrelated to the work.

---

### User Story 2 - An unrecoverable failure stops after one session (Priority: P1)

An operator whose environment is not ready — the coding CLI is installed but not signed in, the
binary is missing, or their usage allowance is exhausted — should be told immediately, with the
remedy, instead of paying for the same impossible attempt three times.

Today every failure is treated as retryable. The one real recorded run made three identical
attempts, 5.4 seconds apart, against a signed-out CLI.

**Why this priority**: It is the most common first-run failure, it is the failure the tool's own
history demonstrates, and it is the only item in this set that saves money rather than time.

**Independent Test**: Force each recognized terminal condition. Confirm exactly one session is
attempted and the stated reason names both the condition and its remedy.

**Acceptance Scenarios**:

1. **Given** a session that fails because the coding CLI is not signed in, **When** the stage
   runs, **Then** the run parks after one attempt and the reason names sign-in as the remedy.
2. **Given** a session that fails because the coding CLI cannot be found, **When** the stage
   runs, **Then** the run parks after one attempt naming the missing binary.
3. **Given** a session that fails because the usage allowance is exhausted, **When** the stage
   runs, **Then** the run parks after one attempt naming the allowance.
4. **Given** a session that fails for any other reason, **When** the stage runs, **Then** the
   existing retry behavior is unchanged — classification never converts a recoverable failure
   into a park.

---

### User Story 3 - The runner starts on every supported machine (Priority: P1)

An operator whose environment provides a suitable runtime — but not under the name the tool
looks for on the search path — should get a working run, not a run that reports itself as
started and then never moves.

Today background processes are launched by asking the search path for a runtime by name. If the
name resolves to nothing, or to a version too old for the tool's own requirements, the launched
process dies immediately into a log file. The run record still says it is in progress, forever:
no failure, no park, no event.

**Why this priority**: It is a total failure with no signal. Everything else in this set is
worthless on a machine where this happens, and the author's own environment provides the runtime
outside the search path.

**Independent Test**: Invoke the tool with a runtime that is not reachable by name on the search
path. Confirm the run advances.

**Acceptance Scenarios**:

1. **Given** a machine where the runtime is not on the search path, **When** a run is started,
   **Then** the run advances through stages normally.
2. **Given** a machine where the name on the search path resolves to a runtime older than the
   tool requires, **When** a run is started or resumed, **Then** the tool uses the runtime that
   is already running it rather than the older one.
3. **Given** any entry point that launches background work — starting, resuming, or restarting a
   run at a chosen stage — **When** it launches, **Then** it uses the same runtime as every
   other entry point.

---

### User Story 4 - A resumed stage knows what failed last time (Priority: P2)

An operator fixes whatever parked a run and resumes it. The resumed stage should begin knowing
what went wrong before, so it does not repeat the attempt that just failed three times.

Today resuming clears the recorded reason before the stage begins, and the failure detail from
the previous process is gone with it. The stage re-issues a byte-identical instruction. The
mechanism for telling a stage "your last attempt failed this verification" already exists and
already works — it is simply never given anything on the resume path.

**Why this priority**: Small, and it makes resume meaningfully different from retry. Sequenced
below P1 because it only matters once parks are diagnosable and runs can start at all.

**Independent Test**: Park a run at a stage with a known verification failure, resume it, and
confirm the resumed session is told about that failure.

**Acceptance Scenarios**:

1. **Given** a run parked with a recorded reason, **When** it is resumed, **Then** the first
   attempt of the resumed stage is informed of that reason.
2. **Given** a run parked with a recorded reason, **When** it is resumed and the first attempt
   succeeds, **Then** no further attempts are made and the run advances.
3. **Given** a run that was never parked, **When** it is resumed, **Then** no previous-failure
   information is fabricated.

---

### User Story 5 - The run works the spec it was given (Priority: P2)

An operator points a run at a specific existing spec, or lets the tool match one. Every
subsequent stage should read, tick, and verify against *that* spec.

Today the choice is used only to decide which stage the run starts at, and is then discarded.
Each stage independently re-resolves "the spec" as the highest-numbered spec directory present.
In a repository with more than one spec, the run analyzes, implements, and verifies a spec the
operator never selected — and reports success for it. Two runs started against the same
repository can also converge on the same spec directory.

**Why this priority**: It produces confidently wrong work rather than a visible failure, which is
worse than a park — but it only bites repositories that already hold multiple specs, so it
sequences below the items that block every run.

**Independent Test**: In a repository holding several complete specs, start a run against a
lower-numbered one and confirm every stage operates on it.

**Acceptance Scenarios**:

1. **Given** a repository with several complete spec directories, **When** a run adopts a
   specific one, **Then** every later stage reads, ticks, and verifies against that directory.
2. **Given** a run that creates a new spec at its first stage, **When** it advances, **Then**
   later stages target the directory that stage actually created.
3. **Given** two runs started against the same repository, **When** both advance, **Then**
   neither operates on the other's spec directory.
4. **Given** a run recorded before this change, or one whose recorded directory is absent from
   its worktree, **When** it advances, **Then** it falls back to today's behavior rather than
   failing.

---

### Edge Cases

- A session fails with no output at all on either channel. The stated reason must still be
  meaningful — it names the exit status and the stage, and never falls back to echoing the
  instruction.
- A session's output ends with decorative or empty lines. The stated reason must skip them and
  reach the last content that carries information.
- A session is killed by the per-stage timeout rather than exiting on its own. The stated reason
  must say the stage timed out, and any output captured before the kill must be retained.
- Two conditions match at once — for example a signed-out CLI that also reports an exhausted
  allowance. Classification must be deterministic, not order-dependent on chance.
- A recognized terminal phrase appears inside ordinary session output — for example the model
  quoting an error while reasoning about it. The run must not park on a session that then
  succeeds; only a *failed* session is classified.
- The stated reason is long. It must be truncated to a bounded length everywhere it is stored or
  displayed, without truncating away the part that identifies the failure.
- A run is resumed twice in a row without any change to the environment. The second resume must
  not accumulate or duplicate previous-failure information.
- The recorded spec directory is deleted, renamed, or is not present in the run's worktree.
  Stages fall back rather than parking on a missing pointer.
- The run's directory is not writable, or the disk is full, when session output is being
  retained. Retaining evidence must never itself fail a run that would otherwise have advanced.

## Requirements *(mandatory)*

### Functional Requirements

**Park diagnosis**

- **FR-001**: The system MUST derive a failed session's stated reason from the content that
  session produced, not from the instruction it was given.
- **FR-002**: The stated reason MUST NOT contain any portion of the stage instruction, under any
  failure mode, including timeout, non-zero exit, and failure to launch.
- **FR-003**: A single stated reason MUST serve every surface that reports the failure — the
  blocked file, the status listing, the recorded event, and the dashboard — so that they can
  never disagree.
- **FR-004**: When a session fails, the system MUST retain that session's output from both its
  normal and error channels, attributed to the run, the stage, and the attempt number.
- **FR-005**: Retained output MUST be readable from the run's own directory without access to
  the worktree, and MUST remain viewable while a run is still in progress.
- **FR-006**: The system MUST tolerate a session producing far more output than a routine one
  without failing the run for that reason alone.
- **FR-007**: Failure to retain output MUST NOT change whether a run advances or parks.

**Terminal failure classification**

- **FR-008**: The system MUST recognize a bounded, explicitly enumerated set of failure
  conditions that cannot succeed on retry, and MUST park on the first occurrence of one rather
  than consuming the retry budget.
- **FR-009**: The initial set MUST be exactly: the coding CLI is not authenticated, the coding
  CLI cannot be found or launched, and the usage allowance is exhausted.
- **FR-010**: Each recognized condition's stated reason MUST name the remedy, not only the
  symptom.
- **FR-011**: Classification MUST fail open: an unrecognized failure retains today's retry
  behavior, and no recoverable failure may be converted into a park.
- **FR-012**: Classification MUST apply only to sessions that failed. Content produced by a
  session that succeeded MUST never trigger a park.

**Runner launch**

- **FR-013**: Every background process the system launches to execute its own code MUST use the
  same runtime that is executing the launching process, never a name resolved from the search
  path.
- **FR-014**: FR-013 MUST hold at every entry point that launches background work, including
  starting a run, resuming a run, restarting a run at a chosen stage, skipping a stage, and
  starting the dashboard server.

**Resume**

- **FR-015**: When a parked run is resumed, the system MUST make the recorded reason for its
  park available to the first attempt of the resumed stage.
- **FR-016**: The system MUST capture that reason before clearing it from the run record.
- **FR-017**: Previous-failure information MUST apply to the first attempt of the resumed stage
  only, and MUST NOT persist into later stages or accumulate across repeated resumes.
- **FR-018**: A run that was not parked MUST be resumed without any previous-failure
  information.

**Spec pinning**

- **FR-019**: When a run adopts an existing spec directory — whether chosen explicitly by the
  operator or matched automatically — the system MUST record that directory on the run.
- **FR-020**: When a run's first stage creates a spec directory, the system MUST record the
  directory that stage actually created.
- **FR-021**: Every stage that reads, verifies, or advances against a spec MUST use the recorded
  directory when one exists.
- **FR-022**: The instruction given to each stage MUST identify the recorded directory, so the
  session and the check that grades it agree on which spec is being worked.
- **FR-023**: When no directory is recorded, or the recorded directory is absent from the
  worktree, the system MUST fall back to today's resolution rather than failing.
- **FR-024**: Two runs against the same repository MUST NOT operate on the same spec directory
  as a result of resolution alone.

**Retention and scope**

- **FR-025**: Output from sessions that succeeded MUST NOT be retained. Only failing attempts
  produce retained output.
- **FR-026**: Retained output MUST be bounded in size per session so that a runaway session
  cannot exhaust the operator's disk.

### Key Entities

- **Run**: the record of one requirement being driven through the pipeline. Gains a recorded
  spec directory. Its stated failure reason changes meaning — from "what we asked" to "what
  went wrong".
- **Stage attempt**: one execution of one stage. Becomes individually identifiable in retained
  output, by stage and attempt number.
- **Park record**: the durable statement of why a run stopped, plus the evidence supporting it,
  both living in the run's own directory.
- **Terminal condition**: a named, enumerated failure that cannot succeed on retry, carrying its
  own remedy text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of park paths exercised by the test suite, the stated reason contains no
  substring of the stage instruction.
- **SC-002**: An operator handed only a parked run's identifier can name the cause and the
  remedy from the run's own directory alone, without opening the worktree, reading the source,
  or re-running anything.
- **SC-003**: Each of the three enumerated terminal conditions consumes exactly one session
  instead of three — a 67% reduction in wasted spend on the most common first-run failure.
- **SC-004**: A run started on a machine whose search path offers no suitable runtime advances
  past its first stage, where today it never moves.
- **SC-005**: No run remains in progress with no owning process and no recorded failure as a
  result of a failed background launch.
- **SC-006**: A resumed stage's first attempt is informed of the previous failure in 100% of
  resumes from a parked state, and in 0% of resumes from a non-parked state.
- **SC-007**: In a repository holding three or more complete specs, 100% of stages after
  adoption operate on the adopted directory.
- **SC-008**: One complete run reaches a green finish end to end against a real repository —
  the outcome the project has not yet achieved once.
- **SC-009**: No successful session's prompt or output is written to disk, verified by
  inspecting the run directory after a clean run.

## Assumptions

- **Retention scope**: only failing attempts have their output retained. Confirmed with the
  operator; chosen over retaining every session because a run makes 10–25 sessions, the failing
  one is the only one read during a park, and prompts plus model output are cleartext on disk.
- **Spec pinning scope**: both adopted and newly created spec directories are recorded.
  Confirmed with the operator; chosen over recording adoptions only because it additionally
  prevents two concurrent runs against one repository from converging on the same spec.
- **Terminal set stays small**: three conditions to start. The cost of a missed classification is
  today's behavior; the cost of a wrong one is a needlessly parked run. The set grows only on
  observed evidence.
- **Retained output lives with the run, not the worktree**: the worktree is disposable and may
  be removed after a run; the run directory is the durable record.
- **Live observability is preserved**: retaining session output must not remove an operator's
  ability to watch a stage while it is still running.
- **No new operator-facing surface is required**: this feature adds no new command, no new
  configuration key, and no new remote interface. It changes what existing surfaces say.
- **Backward compatibility**: runs recorded by an earlier version remain readable and resumable;
  every new field is optional and absent means "behave as before".

## Out of Scope

Deliberately excluded, each considered and rejected during research:

- A dedicated command for reading session logs — the run's blocked file already carries the
  diagnosis once FR-001 is true.
- A separate per-session transcript store, an interface for serving those transcripts, or a
  dashboard panel for them.
- A pre-flight probe that spends a paid session to verify authentication — classification
  already reduces that failure to one wasted attempt, and a pre-flight that costs money or a
  minute violates the purpose of pre-flight.
- Operator notes injected into a resumed stage's instruction, and any interface for supplying
  them.
- Notifications on park or completion.
- Streaming session output as it is produced.
- Any bootstrap or dependency-installation step before the first stage.
