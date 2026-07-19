# autodev — Autonomous Development Pipeline & Mission Control Dashboard

**Date:** 2026-07-19
**Status:** Design approved in brainstorming session; pending user review of this document.

## 1. Overview

autodev turns the manual six-step development workflow (specs → analysis →
implement from tasks.md → push feature branch → code review → testing) into a
**fully autonomous pipeline**: one command takes a raw requirement and produces a
reviewed, tested pull request — with every run visible live on a web dashboard.

- **Generic**: works on any git repository, no repo-specific integrations.
- **Fully autonomous**: no human gates. A run only stops when DONE, or parked
  BLOCKED after exhausting retries.
- **Isolated & parallel**: every run executes in its own git worktree; multiple
  runs (same or different repos) execute concurrently.
- **Reuses installed skills**: each stage invokes an existing Claude Code skill;
  autodev itself adds only the kickoff skill, the runner, and the dashboard.

## 2. Non-goals

- No Jira/Jenkins/enterprise integrations (generic Git + GitHub-style PRs only).
- No approval gates or notification workflows (dashboard is read-mostly; only
  action is Resume on a parked run).
- Not a general Claude observability tool — it tracks pipeline runs only, not
  every Claude session (deliberately smaller than e.g. disler-style
  multi-agent observability).

## 3. Architecture

```
you ── /autodev "<requirement>" ──▶ kickoff skill
                                      │ creates worktree ~/worktrees/<repo>/run-NNN
                                      │ registers run in ~/.autodev/autodev.db
                                      │ spawns runner (detached background process)
                                      ▼
  runner (one process per run) ──────────────────────────────┐
    stage 1-2: claude -p  vista-spec        → specs/NNN-slug/ │ every transition
    stage 3:   claude -p  executing-plans   → code + commits  │ + task tick
    stage 4:   claude -p  ce-commit-push-pr → branch + PR     │ POSTs event ──▶ dashboard server
    stage 5:   claude -p  code-review ⇄ fix → verdict file    │                (localhost:4590)
    stage 6:   claude -p  verify + test cmd → green tests     │                SQLite + SSE
    artifact check after each stage; retry → park             │                     │
  ────────────────────────────────────────────────────────────┘                     ▼
  parallel runs = parallel runner processes                              live web UI (all runs)
```

Components:

1. **`/autodev` kickoff skill** (`~/.claude/skills/autodev/`) — parses the
   requirement + target repo (defaults to cwd), creates the worktree and branch,
   registers the run, launches the runner. Also: `/autodev resume <id>`,
   `/autodev status`, `/autodev stop <id>`.
2. **Runner** (`autodev-runner`, single Node script, ~200-300 lines) — walks the
   stage list; per stage launches a **fresh headless `claude -p` session** with a
   prompt that invokes the mapped skill; validates the stage artifact; handles
   retries and parking; POSTs lifecycle events. State is written to
   `~/.autodev/runs/<id>/state.json` after every transition so a crash or reboot
   resumes from the last completed stage.
3. **Dashboard server** (`autodev-server`, single Node process, port 4590) —
   ingests events (`POST /events`), stores them in SQLite
   (`~/.autodev/autodev.db`), pushes them to browsers over Server-Sent Events
   (`GET /stream`), serves the static UI. Passive: if it is down, runners keep
   working and append events to `~/.autodev/runs/<id>/events.jsonl` for backfill
   on next server start.
4. **Dashboard UI** — implemented from the approved Claude Design project
   ("Autodev Mission Control Dashboard", slate + blue light theme, Space
   Grotesk + IBM Plex): Assembly-Line home (six stage columns, run cards move
   left→right, live ticker, counts) and Run-Detail view (stage stepper, progress
   ring, tasks.md checklist, activity feed, artifacts panel, Resume button on
   blocked runs). The design's HTML is exported and wired to `/stream`.

Design decision — why headless stages instead of one long session: each stage
gets a fresh context window (six stages × retries would exhaust one session),
parallelism is process-level, crash recovery is trivial, and control flow lives
in deterministic code rather than model discipline.

## 4. Stage contracts

The runner never trusts "the model said done" — it advances only when the
stage's artifact check passes.

| # | Stage | Skill invoked | Artifact check (runner-verified) |
|---|-------|--------------|----------------------------------|
| 0 | Worktree | (plain `git worktree add` in runner) | worktree + branch `autodev/NNN-slug` exist |
| 1 | Spec | `vista-spec` (GitHub Spec Kit format) | `specs/NNN-slug/spec.md`, `plan.md`, `tasks.md` exist, non-empty |
| 2 | Analyze | vista-spec `checklists/` self-validation | checklist file has no unchecked gating items |
| 3 | Implement | `executing-plans` on `tasks.md` (TDD baked in) | all tasks `T###` marked done in tasks.md; working tree committed |
| 4 | Push | `ce-commit-push-pr` | branch pushed; PR URL captured to `state.json` |
| 5 | Review | `code-review` → fix pass → re-review (max 3 loops) | verdict file `review.json` = APPROVE |
| 6 | Test | `verify` + repo test command (auto-detected: npm/pnpm test, mvn test, pytest…) | test command exit code 0 |

Stage prompts are templates in the runner (`stages/*.md`), so the skill mapping
is configurable per user without code changes (`~/.autodev/config.json`).

## 5. Event model

Events are small JSON objects; the runner emits lifecycle events, and a
PostToolUse hook inside each headless stage session emits fine-grained activity
(current file being edited, task ticks, test output lines).

```json
{ "run": "012", "repo": "swasthdesk", "ts": 1789000000,
  "type": "stage_started|stage_done|task_done|activity|retry|parked|resumed|run_done",
  "stage": 3, "detail": "T005 — event dispatch", "meta": {"file": "src/webhooks/razorpay.ts"} }
```

The hook config is injected per-run via `--settings` on the headless session so
the user's global hooks are untouched.

## 6. Failure handling

- **Retry policy**: each stage ≤ 2 retries (fresh session, error context passed
  in). Review stage has its own inner fix loop (≤ 3 review⇄fix rounds).
- **Park**: after cap, run state → BLOCKED with a one-paragraph diagnosis
  (written by the failing session as `blocked.md`). Dashboard shows the reason
  and a Resume affordance; `/autodev resume <id>` re-enters at the failed stage.
- **Crash/reboot**: `state.json` is authoritative; resume continues from last
  completed stage. Worktrees and spec folders survive on disk.
- **Runaway protection**: per-run token/time budget in config (default: 6h wall
  clock per run); exceeding it parks the run as BLOCKED(budget).

## 7. Testing autodev itself

- Runner: unit tests for stage sequencing, artifact checks, retry/park logic
  (stage executor mocked as a stub script — no API calls).
- Server: unit tests for event ingest → SQLite → SSE fanout; jsonl backfill.
- End-to-end smoke: a fixture "hello-world" repo + a stub `claude` binary that
  fabricates artifacts, driving a full run through all six stages in seconds.
- One real (paid) canary run against a sandbox repo before calling it shipped.

## 8. Existing-tools analysis (local)

Three complete stage-chains are already installed and are reused, not rebuilt:
superpowers (brainstorming/writing-plans/executing-plans/review), the GSD suite,
and the CE suite. None provides mechanical stage handoff or a live per-stage
dashboard — those are the two genuinely new pieces autodev adds. `vista-spec`
already produces the exact Spec Kit artifact set (spec/plan/tasks/checklists)
and works on any repo.

**Pending addendum**: background deep web research (spec-kit, BMAD, ccpm, Task
Master, claude-flow; disler observability, vibe-kanban, Crystal, OTEL) will be
appended as `2026-07-19-autodev-research-addendum.md` when it completes. If it
surfaces an adoptable dashboard or runner, the corresponding component above is
swapped for adoption rather than building — the stage contracts and event model
stand regardless.

## 9. Build order (input to writing-plans)

1. Dashboard server + event model (foundation others emit into).
2. Runner with stub stage executor + full test loop.
3. Real stage prompts wired to skills; single-run end-to-end.
4. `/autodev` kickoff skill (worktree, register, spawn, resume/status/stop).
5. Dashboard UI: export design HTML, wire to SSE, blocked/resume flow.
6. Parallel-run hardening + canary run.
