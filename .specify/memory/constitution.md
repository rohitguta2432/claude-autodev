<!--
Sync Impact Report
- Version change: (none) → 1.0.0
- Ratification: initial adoption. The template shipped by `specify init` contained only
  placeholder tokens; every principle below is derived from the code, README, and CHANGELOG
  of claude-autodev v0.2.0 as it exists at adoption time, not invented for this document.
- Modified principles: none (initial set)
- Added sections: Core Principles I–VII; Runtime & Platform Constraints; Development Workflow;
  Governance
- Removed sections: none
- Follow-up TODOs: none
-->

# claude-autodev Constitution

claude-autodev turns one requirement into a reviewed, tested pull request by driving seven
sequential headless Claude Code sessions inside an isolated git worktree. It runs unattended,
with the user's real credentials, against the user's real repository. Every principle below
exists because that combination — autonomous, privileged, unwatched — punishes ambiguity
harder than an ordinary CLI does.

## Core Principles

### I. Zero Runtime Dependencies

The shipped package MUST depend on nothing outside the Node ≥22.5 standard library —
`node:sqlite`, `node:http`, `node:child_process`, `node:fs`, `node:crypto`. No production
`dependencies` block in `package.json`, no vendored code, no optional native module.

Rationale: the tool is installed globally onto strangers' machines and then handed
`--dangerously-skip-permissions`. Every dependency is code that runs with that privilege and
that the author has not read. A supply-chain compromise in an autonomous coding agent is not
an ordinary supply-chain compromise. The constraint is also what makes `npm install -g
github:…` work with no build step.

### II. One Source of Truth

Run state lives in exactly two places: the SQLite registry at `$AUTODEV_HOME/autodev.db` and
the append-only `events.jsonl` per run. A feature MUST NOT introduce a third store — no marker
files, no sidecar state, no database column that points at a file which may not exist.

The HTTP server is a reader. Nothing about run correctness may depend on the server being up:
`src/events.js` appends to the jsonl unconditionally and POSTs best-effort, and the CLI reads
and writes the database directly. Any new state MUST be derivable by a process that never
contacts port 4590.

Rationale: a run outlives the dashboard, the terminal that started it, and often the operator's
attention. Two stores that can disagree become a run whose real status nobody can name.

### III. Gates Are Artifacts, Not Self-Report

A stage advances only when a `check()` function observes something on disk that the stage was
supposed to produce — a non-empty `spec.md`, a ticked checklist, a `PASS` verdict in
`.autodev/verify.json`, a real upstream ref, a test command that exited 0. A stage MUST NEVER
advance because a model said it was finished.

New gates MUST follow the same shape: an artifact a human could inspect, checked by code that
did not write it. A gate that cannot fail is not a gate; `"tested PR out"` must never be
vacuous, which is why a missing test command parks the run rather than passing it.

Rationale: the model is the thing being verified. Asking it to grade itself removes the only
independent signal in the pipeline.

### IV. Failure Must Be Legible and Recoverable

When a run parks, the operator gets the reason it actually failed — not an echo of what the
pipeline asked for, not a truncated argv, not a stack trace from the harness. `blocked_reason`
is the single string that reaches `blocked.md`, `autodev status`, the `parked` event, and the
dashboard; it MUST be worth reading on its own.

Failures that cannot succeed on retry MUST be identified as terminal and park on the first
attempt rather than consuming the retry budget. Every park MUST leave enough evidence in
`$AUTODEV_HOME/runs/<id>/` to diagnose it without opening the worktree. A resume MUST carry
forward what was learned; re-issuing a prompt that already failed is a wasted paid session.

Rationale: an autonomous pipeline is judged by what it does when it is wrong. Bounded retries
and a clear park are the product; looping forever, or parking mutely, is the failure mode the
tool exists to avoid.

### V. One Precedence Chain

Configuration resolves in exactly one order, everywhere, without exception:

**CLI flag > per-repo `.autodev.json` > environment variable > built-in default.**

A new setting MUST slot into that chain and MUST document its position in a comment at the
resolution site. A setting MUST NOT be readable from two places with different semantics, and
MUST NOT be persisted to the run row when re-reading its source on runner entry would do — the
runner re-reads `.autodev.json` on every entry, including resume, jump, and skip.

Repo-controlled configuration is data, never code, with one deliberate exception:
`testCmd`/`setupCmd`-style command strings, which the operator has already accepted by pointing
the tool at that repo. Any *new* executable string sourced from a cloned repo, an HTTP body, or
a database row is prohibited — see Principle VII.

### VI. Three Platforms, Proven

Linux, macOS, and Windows are equally supported and CI runs the full suite on all three across
Node 22 and 24. A change MUST NOT use a POSIX-only mechanism without an explicit `win32`
branch — negative-PID process-group kills, `./gradlew`, shell built-ins, path separators
assumed to be `/`.

Subprocess spawning MUST use `process.execPath` for Node children, never a bare `'node'`
resolved from `PATH`: the tool requires Node ≥22.5 for `node:sqlite`, and the interpreter
running the CLI is the only one known to satisfy that.

Every feature ships with `node:test` tests using the existing `test/helpers.js` and the
`AUTODEV_CLAUDE_BIN` stub pattern. Tests MUST NOT spend quota or require network access.
`autodev selftest` MUST continue to drive a fixture repo through all seven stages offline.

### VII. Least Surface

The dashboard binds to `127.0.0.1` only and is never exposed on the network. The codebase makes
no outbound request to the public internet; even Jira is reached through a `claude` subprocess
rather than a direct call. A change that adds public egress, widens the local HTTP surface,
extends the `--dangerously-skip-permissions` blast radius, or alters the worktree trust boundary
MUST be argued explicitly in its spec — never inherited as a side effect of another feature.

Two properties of the current design are load-bearing and MUST be respected by every new
endpoint and every new field:

- The server treats POSTs carrying neither `Origin` nor `Sec-Fetch-Site` as trusted local
  tooling. Any endpoint reachable that way is therefore reachable by a stage session, which the
  runner hands `AUTODEV_PORT` and `AUTODEV_RUN` in its environment.
- Consequently, an endpoint or column that can influence a later stage's prompt, or that
  persists a string the runner will execute, is a self-escalation channel for the very agent it
  is meant to govern. Such a surface MUST require the session token unconditionally, or MUST
  NOT exist.

New settings default to the safer behavior. A feature that writes model output or prompts to
disk is opt-in, with a retention policy decided before it ships.

## Runtime & Platform Constraints

- **Runtime**: Node ≥22.5 (`engines` enforced). ESM only (`"type": "module"`).
- **State**: `$AUTODEV_HOME` (default `~/.autodev`) holds `autodev.db`, `consent`,
  `server.log`, and `runs/<id>/` containing `events.jsonl`, `state.json`, `runner.log`, and
  `blocked.md`. Schema changes are additive, applied through the `ALTER TABLE … ADD COLUMN`
  in-a-`try` migration loop in `src/db.js`, and MUST tolerate rows written by an older binary.
- **Isolation**: each run gets its own `git worktree` and branch. The worktree shares `.git`
  with the main checkout and sessions inherit the full environment — the isolation is against
  concurrent file edits, not against credential access, and documentation MUST keep saying so.
- **Budgets**: bounded retries (2 outer, 3 review⇄fix rounds), a per-stage timeout, a
  wall-clock run budget, and an optional `maxCostUsd` ceiling. A run parks; it never loops.
- **Consent**: `--dangerously-skip-permissions` requires one-time recorded consent obtained on
  a TTY. Non-interactive invocation without recorded consent MUST refuse.

## Development Workflow

- **Spec first.** A behavioral change starts as a `specs/NNN-slug/` set — `spec.md`, `plan.md`,
  `tasks.md` at minimum — before code. The tool imposes this on the repos it drives; it holds
  itself to it.
- **Tests with the change, not after.** New behavior lands with `node:test` coverage in
  `test/`; `npm test` is the gate and CI runs it on the three-platform matrix.
- **Bug fixes ship separately from features.** A correctness fix smuggled inside a feature diff
  is reviewed as feature scope and escapes scrutiny.
- **Effort is stated honestly.** A change touching a new module, the database schema, the HTTP
  API, the CLI surface, and the dashboard is not small because each piece is. Prefer the
  smallest change that gets most of the value; a fix to one wrong line does not justify a
  subsystem.
- **Commits are conventional and explain intent.** The commit body carries the reasoning, not
  just the diff summary.

## Governance

This constitution supersedes convenience and precedent. It binds features authored by humans
and features authored by autodev itself.

- Every spec, plan, and review MUST verify compliance with these principles. A violation is
  either fixed or recorded in the spec's Complexity Tracking section with the concrete reason
  no simpler alternative works — never left silent.
- Amendments require a pull request that states the principle changed, the rationale, and the
  migration for anything already shipped under the old rule.
- Versioning is semantic: MAJOR for a removed or redefined principle, MINOR for a new principle
  or materially expanded guidance, PATCH for clarifications and wording.
- Compliance is reviewed whenever a change touches the runner's control flow, the database
  schema, the HTTP surface, or the `--dangerously-skip-permissions` blast radius.

**Version**: 1.0.0 | **Ratified**: 2026-08-03 | **Last Amended**: 2026-08-03
