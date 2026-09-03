# claude-autodev

[![CI](https://github.com/rohitguta2432/claude-autodev/actions/workflows/ci.yml/badge.svg)](https://github.com/rohitguta2432/claude-autodev/actions/workflows/ci.yml)

Issue in → reviewed, tested, deployed software out. An autonomous 8-stage dev
pipeline for Claude Code with a live mission-control dashboard.

Supported platforms: Linux, macOS, and Windows — the test suite runs on all
three (Node 22 and 24) in CI on every push.

## Why

Give it a one-line requirement and a git repo. It works the whole path —
spec, plan, implementation, verify, push, review, test — in an isolated git worktree,
retrying and self-fixing along the way, and parks itself with a diagnosis
when it truly gets stuck. You watch (or don't) on a dashboard; you get a PR.

Point `autodev daemon` at the repo's issue tracker and it stops needing you at
all: issues become runs, runs become merged and deployed code, and the labels on
each issue are the queue.

## How it works

Each stage runs a headless Claude Code session and only advances once it
produces the artifact the next stage needs — no artifact, no advance.

| # | Stage | Gate (artifact check) |
|---|-------|------------------------|
| 1 | Spec | `specs/NNN-slug/{spec,plan,tasks}.md` all non-empty (or a `REJECT` verdict — see [Mission](#mission-and-factory-rules)) |
| 2 | Analyze | every `- [ ]` in `checklists/*.md` ticked |
| 3 | Implement | every task in `tasks.md` ticked, worktree clean (committed) |
| 4 | Verify | `.autodev/verify.json` verdict is `PASS` (no critical/high findings) |
| 5 | Push | branch has an upstream remote (opens the PR with `gh pr create`) |
| 6 | Review | `.autodev/review.json` verdict is `APPROVE` (loops fix ⇄ re-review) |
| 7 | Test | the repo's own test command exits 0, **and** the holdout scenarios pass |
| 8 | Deploy | the merge and the deploy command both succeed — **opt-in**, see [Deploy](#deploy) |

Nothing in the pipeline shares context between stages: every one is a fresh
`claude -p` session. The reviewer has never seen the plan, and the builder has
never seen the acceptance criteria.

A runner process drives one run through all seven stages, retrying a failed
stage a bounded number of times before parking it `BLOCKED` with a diagnosis
in `~/.autodev/runs/<id>/blocked.md`. A small SQLite registry plus a
per-run `events.jsonl` is the source of truth; an HTTP+SSE server reads both
to drive the dashboard, but nothing about run correctness depends on the
server being up.

## Quickstart

Requirements: Node ≥22.5, `git`, the [Claude Code CLI](https://claude.com/claude-code)
(`claude`), and optionally [`gh`](https://cli.github.com/) for opening PRs.

```bash
npm install -g github:rohitguta2432/claude-autodev#v0.2.0   # pin the tag — master moves
autodev selftest        # ~30s: drives a fixture repo through all 7 stages, no quota spent
autodev doctor          # preflight: node/git/claude/gh/repo/test-cmd, each with a fix
autodev install-skill   # optional: packaged skills into ~/.claude/skills/ (--project for repo-local)
```

```bash
autodev init            # scaffold .autodev/{mission,factory-rules}.md in the target repo
autodev run "add rate limiting to the API" --repo .
autodev run --issue 42 --repo .          # requirement from a GitHub issue
autodev daemon --repo . --interval 30    # pull work from the issue tracker, forever
autodev status
autodev cost <id>       # per-stage sessions / tokens / $
autodev resume <id>     # after fixing whatever parked it BLOCKED
autodev stop <id>
```

The first real run explains `--dangerously-skip-permissions` and asks for
one-time consent. Dashboard: http://127.0.0.1:4590/ — live stage/status per
run, updated over SSE.

### A first run, end to end

```
$ autodev run "add a /health endpoint returning build info" --repo ~/code/myapi
[ PASS ] node >= 22.5 — found 22.12.0
[ PASS ] git on PATH — git version 2.43.0
[ PASS ] claude CLI on PATH — 2.1.205 (Claude Code)
...
run #1 started — autodev/001-add-a-health-endpoint-returning-build
worktree: ~/worktrees/myapi/run-001
dashboard: http://127.0.0.1:4590/
$ autodev status
#001 RUNNING  stage 3/7  myapi  add-a-health-endpoint-returning-build
```

The run advances Spec → Analyze → Implement → Verify → Push (draft PR) →
Review → Test on its own; you get a PR marked ready once review and tests are
green, or a `BLOCKED` status with a diagnosis in
`~/.autodev/runs/1/blocked.md` if it truly gets stuck.

## Mission and factory rules

`autodev init` scaffolds two optional files in the **target** repo. Both are absent
by default and the pipeline behaves exactly as it did without them.

`.autodev/mission.md` — goals and non-goals. Its only job is to let the spec stage
say **no**: a requirement that hits a non-goal is written up as
`{"verdict":"REJECT"}`, the run ends `REJECTED` before any code exists, and the
reason lands in `~/.autodev/runs/<id>/blocked.md`. Without this file nothing is
ever out of scope, and the factory can only ever obey you.

`.autodev/factory-rules.md` — constraints that bind **only** unsupervised work, and
are prepended to every session in the run. Keep them stricter than your
`CLAUDE.md`: that one governs work a human is watching, this one governs work
nobody is watching. The test for which file a rule belongs in is whether you would
still want it when you are sitting there.

## Holdout scenarios

The stage-7 test suite is written by the builder, so passing it proves the builder
agrees with itself. The holdout suite is not.

At stage 1 the spec session also writes `.autodev/holdout/scenarios.md` —
end-to-end acceptance scenarios in operator language, no implementation detail. The
moment the spec gate passes, the runner **moves that directory out of the worktree**
into `~/.autodev/runs/<id>/holdout/` and adds it to `.git/info/exclude`, so it is
absent from both the working tree and the history for every session that follows.
It comes back for exactly one session — the acceptance check at the end of stage 7 —
and is removed again before any fix session runs. A failing scenario is fed back to
the builder as *what was observed*, never as the scenario itself, so it cannot
special-case its way to green.

If the spec session writes no scenarios the stage is skipped and logged; the run
still completes. Once scenarios exist, a `FAIL` verdict parks the run even with a
green test suite.

## The queue

`autodev daemon --repo <path>` turns a pipeline into a factory. One tick, in
priority order:

1. **reconcile** — every issue whose run has finished gets its label and a comment:
   `autodev:shipped` (closed), `autodev:rejected` (closed, with the mission's reason),
   or `autodev:blocked` (left open, with the resume command).
2. **dispatch** — start runs for `autodev:accepted` issues, oldest first, up to
   `--max-parallel` (default 2). Concurrency is counted from the run registry, not
   from the daemon's memory, so restarting it mid-tick cannot double-start work.
3. **accept** — with `--auto-accept`, label untriaged issues so step 2 can pick them
   up next tick. **Off by default**: on a public repo it would let any stranger's
   issue start an autonomous build.

Scope judgement is deliberately *not* the daemon's job — it belongs to the spec
stage reading `mission.md`, the only place in the system that knows what the repo
is for. The daemon just relays the verdict back to the issue.

State lives in exactly two durable places: the issue's labels and the `issue_ref`
column on the run. Kill the daemon whenever; the next tick reconstructs everything.

## Deploy

Merging is not shipping. A pipeline that stops at an approved PR is a PR generator,
so stage 8 exists — but only when the target repo asks for it in `.autodev.json`:

```json
{ "deploy": { "merge": true, "strategy": "squash", "cmd": "./deploy.sh" } }
```

`merge` merges the run's PR with `gh pr merge --delete-branch` (`strategy` is
`squash` | `merge` | `rebase`); `cmd` then runs in the **main repo path**, not the
worktree — that is where your deploy tooling and credentials live. Either half can
be omitted: `{"deploy":{"merge":true}}` merges and stops, `{"deploy":{"merge":false,
"cmd":"..."}}` deploys something you merge elsewhere.

The stage is not agentic. The runner runs both steps and **parks on failure** with
the output in `~/.autodev/runs/<id>/deploy-output.txt`; there is no fix loop,
because a half-deployed application is the one place in this pipeline where another
unsupervised session can make things materially worse.

For zero-downtime, put a blue-green flip in `cmd`: deploy to standby, health-check
it, then switch. autodev has no opinion beyond "the command must exit 0".

### Proof

Every gate leaves its artifact with the run: after verify, review, test and deploy the runner
copies `verify.json`, `review.json`, `test-output.txt` (and `holdout.json`,
`deploy-output.txt` when those ran) into `~/.autodev/runs/<id>/proof/` and records a `proof`
event naming what it kept. The deploy stage records `merged` (the merge commit) and
`deployed` (command, exit, seconds) as events too.

A repo can add its own evidence with `proofCmd`:

```json
{ "deploy": { "merge": true, "cmd": "./deploy.sh", "proofCmd": "./proof.sh" } }
```

It runs after `cmd`, in the main repo path, with `AUTODEV_PROOF_DIR` and `AUTODEV_RUN` in its
environment, and must exit 0 and leave at least one file in that directory — a production
screenshot, a health-check response, a version endpoint's answer. A proof command that fails or
writes nothing parks the run: a deploy nobody can show is not done.

When the Jira queue closes a ticket, it attaches every file in `proof/` (≤ 10 MiB each), posts
a comment built from the run's own event log — pull request, merge commit, what was deployed
and when, the test command, the verdicts, the attached file names — and only then transitions
the issue. A run that never deployed says "not deployed by autodev" in that comment; an upload
failure leaves the ticket open for the next tick.

## Troubleshooting

| symptom | cause / fix |
|---------|-------------|
| `no test command detected — pass --test-cmd …` (run parks at stage 7) | detection covers npm/pytest/tox/maven/gradle/go/cargo/make/dotnet at the root and one subdir level; anything else needs `--test-cmd "<cmd>"` or `"testCmd"` in `.autodev.json` |
| `branch has no upstream — push failed` (parks at stage 5) | the repo has no `origin` remote or no push rights; add one, or run with `--no-push` |
| `review verdict: REQUEST_CHANGES` after 3 rounds | the review⇄fix loop spent its budget; read `.autodev/review.json` in the worktree, fix or relax, then `autodev resume <id>` |
| `cost budget exceeded: $… >= maxCostUsd` | raise `maxCostUsd` in `.autodev.json` and `autodev resume <id>` |
| `no TTY to confirm on — run autodev once interactively` | the skip-permissions consent hasn't been recorded; run any `autodev run` from a terminal once |
| `the claude CLI is installed but not signed in` (parks at stage 1, after **one** session) | `claude --version` passes while logged out, so `doctor` can't catch this; run `claude` once interactively, then `autodev resume <id>` |
| `the claude CLI could not be launched` | `claude` isn't on `PATH`; install it or point `AUTODEV_CLAUDE_BIN` at it |
| `the Claude usage allowance for this account is exhausted` | wait for the reset (or raise the limit), then `autodev resume <id>` |

A parked run's reason names what failed and how to fix it. When one line isn't
enough, `~/.autodev/runs/<id>/runner.log` holds the failing session's own
output, attributed by stage and attempt — successful sessions are not recorded.
These three conditions cannot succeed on retry, so they park immediately rather
than spending three sessions to prove it; everything else keeps the normal
retry budget.

## Configuration

Precedence everywhere: **CLI flag > `.autodev.json` > env var > default**.

Per-repo `.autodev.json` (committed to the *target* repo):

| key | example | effect |
|-----|---------|--------|
| `testCmd` | `"cd backend && pytest -q"` | Test-stage command when detection isn't enough |
| `model` | `"claude-sonnet-5"` | model for every stage session |
| `stageModels` | `{"review": "claude-opus-4-8"}` | per-stage override (keys: spec, analyze, implement, verify, push, review, test) |
| `maxCostUsd` | `10` | park the run before any session beyond this budget |
| `until` | `"analyze"` | always stop after this stage |
| `push` | `false` | never push/PR — caps runs at Verify |
| `branchPrefix` | `"feature"` | branch naming: `<prefix>/NNN-slug` |
| `deploy` | `{"merge":true,"cmd":"./deploy.sh","proofCmd":"./proof.sh"}` | enables stage 8 — see [Deploy](#deploy) and [Proof](#proof). Absent = 7-stage pipeline |

Env vars:

| var | default | effect |
|-----|---------|--------|
| `AUTODEV_CLAUDE_MODEL` | – | pin a model for every stage session |
| `AUTODEV_HOME` | `~/.autodev` | state dir (db, run logs, consent) |
| `AUTODEV_WORKTREES` | `~/worktrees` | where run worktrees are created |
| `AUTODEV_PORT` | `4590` | dashboard port |
| `AUTODEV_JIRA_BASE` | – | Jira base URL for dashboard ticket links |
| `AUTODEV_JIRA_CLOUD_ID` | – | pin the Atlassian cloudId for Jira-mode fetches |
| `AUTODEV_CLAUDE_BIN` | `claude` | claude binary override (a `.js` path runs via node — test stubs) |

## Cost

Every stage is a full headless `claude -p` session; with retries and the
review ⇄ fix loop a single run is realistically **10–25 sessions**, none sharing
context. Headless sessions use the same credentials as interactive Claude Code:
subscription login draws on your subscription limits, while an
`ANTHROPIC_API_KEY` in the environment bills **per token** instead
(`autodev doctor` warns when one is set). To see and cap spend:

- `autodev cost <id>` — per-stage sessions/tokens/cost summed from the run's
  metrics events (also visible per stage on the dashboard).
- Pin cheaper models: `AUTODEV_CLAUDE_MODEL` for everything, or per stage in
  `.autodev.json` — `{"stageModels": {"implement": "claude-sonnet-5"}, "model": "claude-sonnet-5"}`
  (per-stage > repo-wide > env).
- Hard ceiling: `{"maxCostUsd": 10}` in `.autodev.json` parks the run before
  any session that would start beyond the budget; raise it and `autodev resume`.

## Smart spec detection

If `specs/NNN-*` directories already exist in the target repo, `autodev run`
looks for one whose slug overlaps the requirement's words and is complete
(non-empty `spec.md`/`plan.md`/`tasks.md`). A single match is adopted and the
run starts at stage 2 (Analyze) instead of stage 1. Ambiguous or no match →
starts fresh at stage 1. To force a specific spec, pass `--spec <path>`.

## How it's built

- Zero runtime dependencies — Node 22 stdlib only (`node:sqlite`, `node:http`,
  `node:child_process`, `node:fs`).
- Run state lives in a SQLite registry (`~/.autodev/autodev.db`) plus an
  append-only `events.jsonl` per run; the dashboard is server-sent events
  over plain `http.createServer`, no framework.
- Each run gets its own `git worktree` and branch (`autodev/NNN-slug`), so
  multiple runs — even against the same repo — proceed in parallel without
  stepping on each other's working tree.

## Safety notes

- Headless Claude sessions run with `--dangerously-skip-permissions`. The first
  `autodev run` explains this and asks for one-time consent (recorded in
  `~/.autodev/consent`). The worktree scopes *file edits* away from your main
  working copy, but be clear about what it does **not** isolate: the worktree
  shares `.git` with your main checkout, and sessions inherit your full
  environment — credentials included. Only point autodev at repos and
  requirements you'd trust an unsupervised agent with.
- Stage 8 merges and deploys **without a human approving the merge**. It is off
  unless you put `deploy` in `.autodev.json`, and turning it on means an agent's
  work can reach your users with no person in the path. Enable it on a repo whose
  deploy is reversible, and keep the escalation path real: a parked run is the
  factory asking for you.
- `autodev daemon --auto-accept` lets anyone who can file an issue in that repo
  start an autonomous run. Leave it off on public repos; without it, an issue only
  moves when someone with write access labels it `autodev:accepted`.
- The dashboard server binds to `127.0.0.1` only; it's never exposed on the
  network.
- Each stage has a retry cap (default 2 outer retries, 3 review⇄fix rounds)
  and the whole run has a wall-clock budget (default 6h) — it parks rather
  than looping forever.

## Skill composition

autodev's stage prompts prefer a few Claude Code skills if you have them
installed — a GitHub-Spec-Kit-style spec skill, an execute-plan skill, a
commit/push/PR skill, a code-review skill, a systematic-debugging skill —
but every stage also carries an inline fallback describing exactly what
artifact it needs, so the pipeline works with a stock Claude Code install
too. Installed skills just tend to produce better results.

## License

MIT — see [LICENSE](LICENSE).
