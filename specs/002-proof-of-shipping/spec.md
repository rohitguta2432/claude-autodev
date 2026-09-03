# Feature Specification: Proof of Shipping

**Feature Branch**: `main` (committed directly — the installed binary is a symlink to this checkout)

**Created**: 2026-09-03

**Status**: Implemented

**Input**: Rohit, after watching run #4 (SCRUM-45) end: "make that autodev, after completing,
deploy and close ticket with proof."

## Context

Run #4 did everything the pipeline promised — spec, implement, verify, push, review, test — and
then the Jira queue marked SCRUM-45 *Done* with one sentence: "autodev run #4 shipped this …
Marked Done automatically." Nothing was deployed, because the target repo had never opted into
stage 8, and nothing on the ticket let anyone check the claim: no test output, no verdicts, no
screenshot of the fix in production, not even the merge commit. The ticket said *Done*; the
change was sitting in an open pull request that conflicted with `main`.

Two gaps, both in this repository:

1. The pipeline's own evidence is thrown away. `.autodev/verify.json`, `review.json`,
   `test-output.txt` live in the worktree, which the operator clears; `deploy-output.txt` lands
   in the run directory but nothing reads it. The runner *has* the proof at the moment each gate
   passes and keeps none of it.
2. The Jira close is self-report. The queue writes a sentence that would be identical for a
   run that deployed to production and one that merely opened a PR.

The constitution's Principle III says a gate is an artifact checked by code that did not write
it. This feature extends that to the ticket: the close carries the artifacts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The ticket is closed with the evidence, not a sentence (Priority: P1)

A product owner opens a ticket the queue marked *Done*. They see, attached, the test output, the
review and verify verdicts, the deploy log and whatever the repo's proof command produced (for
TableTalk: a screenshot of production), and a comment stating — from the runner's event log,
not from a session — the PR, the merge commit, what was deployed and when, and which files are
attached. A run that did not deploy says so in the same place.

**Why this priority**: it is the request. A *Done* the reader cannot check is worth less than an
open ticket.

**Acceptance Scenarios**:

1. **Given** a finished run whose `proof/` holds files, **When** the queue reconciles it,
   **Then** every file is attached to the issue, a comment listing them and the run's facts is
   posted, and only then is the issue transitioned — attach, comment, transition, in that order.
2. **Given** attaching a file fails, **When** the queue reconciles, **Then** no comment is
   posted, no transition happens, the tick logs the failure and the run is retried next tick.
3. **Given** a run with no `merged`/`deployed` events (a 7-stage repo), **When** the comment is
   built, **Then** it says the change was not deployed by autodev rather than implying it was.

### User Story 2 - Every gate leaves its artifact in the run directory (Priority: P1)

After verify, review, test and deploy, the runner copies the stage's artifact into
`$AUTODEV_HOME/runs/<id>/proof/` and records a `proof` event naming what it kept. The worktree
can be cleared; the evidence survives with the run.

**Acceptance Scenarios**:

1. **Given** a green run, **Then** `proof/` holds `verify.json`, `review.json`,
   `test-output.txt` (and `holdout.json` when scenarios ran, `deploy-output.txt` when deploy ran).
2. **Given** an artifact was never written, **Then** it is absent from `proof/` and from the
   comment's attachment list — never substituted.

### User Story 3 - The deploy stage records what it did and can prove it (Priority: P2)

Stage 8 emits a `merged` event carrying the merge commit and a `deployed` event carrying the
command, exit and duration. A repo may add `deploy.proofCmd`; it runs after the deploy in the
main repo path with `AUTODEV_PROOF_DIR` set, and must exit 0 and leave at least one file there.
A proof command that fails or leaves nothing parks the run: a deploy nobody can show is not
"closed with proof".

**Acceptance Scenarios**:

1. **Given** `deploy.proofCmd` writes a file into `AUTODEV_PROOF_DIR`, **Then** the run ends
   `DONE`, the file is in `proof/`, and the events hold `deployed` and `proof`.
2. **Given** `deploy.proofCmd` exits non-zero or writes nothing, **Then** the run parks at
   stage 8 with a reason naming the proof command.
3. **Given** the PR is already merged when stage 8 runs (a resume after a proof failure),
   **Then** the merge is skipped and its commit recorded, rather than failing on `gh pr merge`.

## Functional Requirements

- **FR-001** The runner MUST copy stage artifacts into `runs/<id>/proof/` after verify, review,
  test and deploy, and MUST emit a `proof` event listing the names added.
- **FR-002** Stage 8 MUST emit `merged` (commit + strategy) after a merge and `deployed`
  (command, exit, seconds) after the deploy command.
- **FR-003** Stage 8 MUST skip the merge when `gh pr view` reports the PR `MERGED`.
- **FR-004** `deploy.proofCmd` MUST run in the main repo path with `AUTODEV_PROOF_DIR` and
  `AUTODEV_RUN` set; non-zero exit or no new file MUST park the run with a terminal reason.
- **FR-005** The Jira queue MUST, for a `DONE` run, attach every `proof/` file ≤ 10 MiB, post a
  comment built by `proofReport`, then transition — and MUST NOT comment or transition when an
  attachment fails.
- **FR-006** The comment MUST be derived only from the run row, the event log and the proof
  files. It MUST state "not deployed by autodev" when no `deployed` event exists.
- **FR-007** Tests MUST cover the report builder, proof collection, the proof command's success
  and failure, and the queue's attach→comment→transition order against a local stub Jira.

## Constitution check

- **II (one source of truth)**: `proof/` is evidence, like `blocked.md` and `runner.log`, not
  state. The comment is derived from `events.jsonl`; nothing new is persisted to the run row.
- **III (gates are artifacts)**: the close carries the artifacts. `proofCmd` leaving nothing is a
  gate failure.
- **V (one precedence chain)**: `proofCmd` lives under `deploy` in `.autodev.json` only.
- **VII (least surface)**: `proofCmd` is a command string from the target repo's committed
  `.autodev.json`, the same class as `deploy.cmd` and `testCmd`. The attachment upload goes to
  the same Jira host the queue already reaches. No new endpoint.
- **VI (three platforms)**: no shell built-ins in product code; `proofCmd` is the repo's own
  shell string, like `cmd`.

## Out of scope

- A screenshot facility inside autodev. Proof is repo-specific; the repo owns `proofCmd`.
- Re-running the deploy stage for runs that finished before this feature. Run #4 was resumed
  at stage 8 by hand (see the ordertable spec 044).
- Inline images in the Jira comment (needs the media API). Files are attachments.

## Deliberately not met

- On a resume after a proof failure, the deploy command runs again (a redeploy of the same
  commit). Skipping it would need a rule for telling "proof failed" from "deploy failed" on the
  same stage; the redeploy is harmless and rare. `ponytail:` in `runner.js`.
- Attachment retries after a partial failure can attach the same file twice. Jira tolerates
  duplicates; a dedupe by name would hide a genuinely new file with the same name.
