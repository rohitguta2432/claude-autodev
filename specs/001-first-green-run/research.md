# Research: First Green Run

Phase 0 output. The spec's clarification round left no `NEEDS CLARIFICATION` markers, so this
phase resolved *mechanism* rather than open questions: how each requirement is met with the
smallest change that does not violate the constitution.

Every decision below that concerns Node behavior was **measured**, not recalled. The measurement
overturned the first draft of the plan.

---

## R1 — Exec mechanism: keep `execFileSync`, catch and re-throw

**Decision**: leave `execFileSync` in place. Wrap the call in `try`/`catch` and throw a
replacement error whose message is built from `e.stdout` + `e.stderr`. Raise `maxBuffer`.

**Measurement**. Node 22, the four failure modes `runClaude` can hit:

| Failure mode | `e.code` | `e.status` | `e.message` | `e.stdout` | `e.stderr` |
|---|---|---|---|---|---|
| Session exits non-zero | `undefined` | exit code | `Command failed: <full argv>` — **contains the prompt** | captured | captured |
| Binary not found | `ENOENT` | `null` | `spawnSync <bin> ENOENT` | `""` | `""` |
| Per-stage timeout | `ETIMEDOUT` | `null`, `signal: SIGTERM` | `spawnSync <bin> ETIMEDOUT` | partial | partial |
| Output exceeds `maxBuffer` | `ENOBUFS` | `null`, `signal: SIGTERM` | `spawnSync <bin> ENOBUFS` | partial | `""` |

Two findings decide the design:

1. **Only the non-zero-exit message echoes argv.** The other three name their condition and stop.
   So the defect is narrower than assumed: one case, one message.
2. **Both channels are already on the error object.** `e.stderr` is populated on every throwing
   path. Nothing needs to be re-plumbed to obtain it.

Today `runClaude` does not catch at all. `execFileSync` throws, the stage loop catches at the
outer level, reads `e.stdout` into `lastOut`, and `park()` writes `String(err.message)` as the
reason — which is how the prompt ends up being the diagnosis while the real cause survives only
inside the `## Last output` block that `lastOut` feeds.

**Rationale**: catching inside `runClaude` fixes `blocked_reason`, both `retry` events, the
`parked` event, `autodev status`, and the dashboard badge simultaneously, because all of them
read the same string. It is ~8 lines and adds no new surface.

**Alternatives considered**:

- *Replace with `spawnSync`* — the first draft of this plan. `spawnSync` returns
  `{ status, signal, stdout, stderr, error }` and throws nothing, which is tidier in the
  abstract. Rejected once measured: it buys nothing `execFileSync` does not already provide on
  the failure path, and it costs the live stderr forwarding described in R2. A larger diff for a
  strictly worse result.
- *`spawn` with `--output-format stream-json`* — rejected in the feature-research phase and again
  here. It replaces the core execution path, changes timeout and kill semantics, and changes the
  shape `parseClaudeResult` consumes. Out of proportion to a wrong error message.
- *Post-process `e.message` to strip the prompt* — rejected. Depends on Node's message format
  and on the prompt not containing the delimiter; brittle where the alternative is exact.

**`maxBuffer`**: default is 1 MiB. A 45-minute agent session under `--output-format json` can
plausibly exceed it, and today the result is `ENOBUFS` — an opaque park unrelated to the work.
Raised to 64 MiB, which is generous against observed session sizes and still bounded. Note this
is a *latent* bug being fixed opportunistically, not a hypothetical: overflow kills the child
with `SIGTERM` and discards the run's progress.

---

## R2 — Live stderr forwarding is preserved, not traded

**Decision**: do not specify `stdio` on the `execFileSync` call. Leave Node's default.

**Measurement**: with `stdio` unspecified, a child's stderr is **both** forwarded to the parent's
stderr **and** captured onto the thrown error. Verified directly — the child's stderr appeared on
the terminal *and* in `e.stderr` in the same run.

Because `spawnRunner` redirects the runner's own stdout and stderr into
`$AUTODEV_HOME/runs/<id>/runner.log`, that forwarding is what puts session stderr into
`runner.log` live today. Specifying `stdio: ['ignore', 'pipe', 'pipe']` — as the `spawnSync`
draft required — would have ended it, converting a live signal into a post-mortem one for a tool
whose selling point is a live dashboard.

**Rationale**: there is no trade-off to make. The measurement removed it.

**Note for a future maintainer**: the live signal that actually drives the dashboard is the
`PostToolUse` hook wired through `bin/hook-emit.js`, not stderr — `claude -p --output-format json`
is essentially silent until it returns. So even had the trade been real, it would have been
small. It is worth knowing which of the two mechanisms carries the signal before touching either.

---

## R3 — Retained output goes into the existing `runner.log`, failing attempts only

**Decision**: on a failed attempt, append a delimited block to
`$AUTODEV_HOME/runs/<id>/runner.log` containing the stage, attempt, exit status, duration, and
the session's stdout and stderr. Size-capped. Nothing is written for a session that succeeded.

**Rationale**:

- `runner.log` already exists in the run directory, is already the file the runner's own output
  lands in, and is already tailable while a run is in progress. Adding attribution headers to a
  file that is already there costs one function and creates no new artifact to document, prune,
  or serve.
- Failing-attempts-only was chosen by the operator during the spec's clarification round. It is
  also what the exec mechanism naturally supports (R1): `execFileSync` hands back both channels
  on failure and discards stderr on success. Mechanism and policy agree, which is a good sign
  rather than a coincidence to design around.
- Constitution Principle VII asks that new on-disk model output be bounded and minimal. A run
  makes 10–25 sessions; retaining only the ones that failed is roughly an order of magnitude less
  cleartext prompt and model output than retaining all of them.

**Alternatives considered**:

- *A `sessions/<stage>-<attempt>.log` directory* — rejected. It adds a naming scheme, sequence
  seeding across resumes, a pruning question, and a nullable database pointer to a file that may
  legitimately not exist. That last item is a Principle II violation for no gain.
- *An HTTP route serving the logs, plus a dashboard panel* — rejected. It puts complete model
  output, including whatever the agent read from the repository, behind an unauthenticated
  localhost `GET`. Principle VII prohibits widening the HTTP surface as a side effect.
- *An `autodev logs <id>` command* — rejected. It competes with `cat blocked.md`, which works
  today and works better once R1 lands.

**Size cap**: 1 MiB retained per session block — the first 200 KiB and the last 800 KiB with an
elision marker between them. The tail is where the cause lives; the head is where the invocation
context lives; the middle is the agent thinking out loud.

---

## R4 — Three terminal conditions, detected narrowly, failing open

**Decision**: classify exactly three conditions as terminal, park on first occurrence, and set
the existing `final` flag that the retry loop at the top of the stage loop already honors.

| Condition | Detection basis | Why terminal |
|---|---|---|
| Coding CLI not authenticated | text match on the session's combined output | No number of retries signs a user in |
| Coding CLI not found / cannot launch | **structural**: `e.code === 'ENOENT'` | The binary will not appear during the retry window |
| Usage allowance exhausted | text match on the session's combined output | Retrying inside the same run cannot restore an allowance |

**Rationale**: this is the only item in the change set that saves money rather than time, and the
tool's own history is the evidence — the single recorded run made three identical attempts, 5.4
seconds apart, against a signed-out CLI.

**Detection rules**, in the order they are applied:

1. `ENOENT` first, because it is structural and cannot be confused with content.
2. Authentication next.
3. Allowance last.

Fixed order makes the outcome deterministic when a session's output somehow matches more than
one, which the spec's edge cases require.

**Fail-open is mandatory** (FR-011): an unmatched failure keeps today's retry behavior exactly.
The cost of a missed classification is the status quo; the cost of a wrong one is a run parked
that would have succeeded. The asymmetry sets the default.

**Classification runs only on failure** (FR-012). A session that exits zero is never inspected,
so a model quoting `Not logged in` while reasoning about an error cannot park a run.

**Rate limiting is deliberately excluded** from the allowance condition. A transient rate limit
is exactly the kind of failure retries exist for; folding it in would convert a recoverable
failure into a park and violate the asymmetry above.

**Alternatives considered**:

- *A larger initial set* — rejected. Each entry is a false-positive risk, and there is no
  observational evidence for a fourth. The set grows when a real run produces a reason to grow it.
- *Classifying by exit code* — rejected. The coding CLI does not document stable exit codes per
  condition; text and `ENOENT` are what is actually available.

---

## R5 — No authentication probe in `doctor`

**Decision**: `doctor` is unchanged. It continues to check that the CLI is installed, not that it
is signed in.

**Rationale**: an authentication probe means spending a real session on every kickoff whose cache
has expired, to prevent a failure that R4 already reduces to one wasted attempt — paying on every
run to avoid paying once on a rare broken one. It would also consume the very allowance whose
exhaustion is one of the conditions it detects, and it contradicts `doctor`'s own stated purpose:
a stranger's first failure should cost five seconds. Today every check is a local probe; bolting
a network call with a 60-second timeout onto preflight changes what preflight *is*.

**Accepted consequence**: `claude --version` passes while signed out, so `doctor` will keep
reporting green on a machine where run 1 died. R4 is the mitigation, and it is a better one — it
reports the problem with its remedy at the moment it actually matters, at a cost of one session.

**If ever wanted**: `autodev doctor --auth`, opt-in, never part of `run` preflight.

---

## R6 — Spec pinning by nullable column, resolved through one function

**Decision**: add a nullable `spec_dir` column holding a **repo-relative POSIX path**. Populate it
at kickoff when a spec is adopted, and after stage 1 succeeds with the directory that stage
actually created. Every consumer resolves through a single shared function.

**Rationale**:

- The path is relative and resolved against `run.worktree`, so it is not a pointer to a machine
  location that can go stale when a worktree moves. It is stored POSIX-style even on Windows —
  it identifies a location inside a repository, not on a filesystem.
- One resolver, used by the stage checks, the stage prompts, and the dashboard's task pane,
  guarantees the session and the check that grades it agree on which spec is being worked. Two
  resolvers would reintroduce the bug in a new place.
- Recording what stage 1 *creates*, not just what is *adopted*, was the operator's choice in the
  clarification round. It costs one extra write and additionally prevents two concurrent runs
  against one repository from converging on the same directory as `specs/` grows underneath them.

**Fallback is required, not optional** (FR-023). A run recorded by an older binary has no
`spec_dir`; a worktree may not contain the recorded directory. Both fall back to today's
"highest-numbered directory wins" resolution. A pointer that can fail must never be the reason a
run parks.

**Alternatives considered**:

- *Store an absolute path* — rejected. Breaks when the worktree root differs from the recorder's,
  which is exactly the resume and jump case.
- *Derive the directory from the branch name* — rejected. The branch slug is derived from the
  requirement, not from the spec, and `--branch` lets an operator sever the relationship entirely.
- *Warn on drift instead of pinning* — considered and offered to the operator; not chosen. A
  warning leaves the wrong work still being done.

---

## R7 — Pure helpers live in a new stateless module

**Decision**: add `src/session.js` exporting `causeLine`, `classify`, and `sessionBlock`. No I/O,
no state, no imports beyond what pure string work needs.

**Rationale**: the adversarial review of this feature recommended writing the classifier inline in
`src/runner.js` — correct in spirit, since it has exactly one caller. It is not possible: `runner.js`
is a top-level script with side effects. It reads `process.argv`, opens the database, and begins
executing the pipeline the moment it is imported, so no test can import anything from it. A
helper that cannot be unit-tested in a change whose entire purpose is trustworthy failure
reporting is the wrong trade.

The module stays honest by staying stateless. It stores nothing, so it does not become a second
source of truth under Principle II; `sessionBlock` returns a string and lets the caller decide
whether and where to write it.

**Alternatives considered**:

- *Put them in `src/stages.js`* — rejected. That module is the stage table and its artifact
  checks; session mechanics are a different concern and would be found there by nobody.
- *Export them from `src/runner.js` behind an `import.meta.main` guard* — rejected. It restructures
  the runner's entry semantics to avoid creating a 35-line file. Wrong direction.
