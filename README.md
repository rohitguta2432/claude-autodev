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
| 5 | Push | branch has an upstream remote (opens the PR with `gh pr create`; with `pushMode: "direct"` the runner rebases and pushes the branch itself — no session, no PR) |
| 6 | Review | `.autodev/review.json` verdict is `APPROVE` (loops fix ⇄ re-review) |
| 7 | Test | the repo's own test command exits 0, **and** the holdout scenarios pass |
| 8 | Deploy | the merge (or, direct mode, the fast-forward of the base branch) and the deploy command both succeed — **opt-in**, see [Deploy](#deploy). One deploy per repo at a time: parallel runs queue on a lock here |

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
autodev doctor          # preflight: node/git/claude/gh/repo/test-cmd/config/account, each with a fix
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

With `"pushMode": "direct"` there is no pull request to merge. Stage 5 rebases the run's
branch onto the base branch (`baseBranch`, default `origin/HEAD` → `main`) and pushes the
branch; stage 8, after the tests, rebases once more and fast-forwards the base branch to
it with `git push origin HEAD:<base>`. A rebase conflict parks the run naming the branch,
with the rebase aborted, for the operator to resolve and resume. Neither step spends a
session or needs `gh`. This is the mode for a repo whose rule is "commit on main and
deploy in the same session" — a GitHub merge of a PR that main has moved under (`This
branch can't be rebased`) was the most common park before it.

Runs can implement and test in parallel (`maxParallel` on the Jira queue), but deploys
are serialised: stage 8 takes a per-repository lock under `~/.autodev/locks/` and waits
for the run holding it; a lock left by a dead runner is reclaimed.

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
| `the claude CLI is not signed in` (parks before stage 1) | the runner asks `claude auth status` before spending a session; run `claude`, `/login`, then `autodev resume <id>` |
| `rebase onto origin/main conflicts` (parks at stage 5 or 8, direct mode) | resolve on the run's branch in its worktree, commit, `autodev resume <id>` |
| `branch has no upstream — push failed` (parks at stage 5) | the repo has no `origin` remote or no push rights; add one, or run with `--no-push` |
| `review verdict: REQUEST_CHANGES` after 3 rounds | the review⇄fix loop spent its budget; read `.autodev/review.json` in the worktree, fix or relax, then `autodev resume <id>` |
| `no TTY to confirm on — run autodev once interactively` | the skip-permissions consent hasn't been recorded; run any `autodev run` from a terminal once |
| `the claude CLI is installed but not signed in` (parks at stage 1, after **one** session) | `claude --version` passes while logged out, so `doctor` can't catch this; run `claude` once interactively, then `autodev resume <id>` |
| `the claude CLI could not be launched` | `claude` isn't on `PATH`; install it or point `AUTODEV_CLAUDE_BIN` at it |
| `the Claude usage allowance for this account is exhausted` | wait for the reset (or raise the limit), then `autodev resume <id>` |
| `... exist here but are untracked: a run's fresh worktree will not have them` (`autodev doctor` WARN), or the build fails in the run's worktree with a missing SDK path / `.env` / keystore | name the files it needs in `worktreeCopy` in `.autodev.json`; entries that are already tracked are skipped, since the worktree already has the committed copy |
| `.autodev.json` seems ignored (`maxCostUsd` not enforced, `push: false` not honored) | runs read the committed copy in the run worktree; an untracked or uncommitted config never arrives there. Commit it; `autodev doctor` warns about this |

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
| `model` | `"claude-sonnet-5"` | model for every stage session (default `claude-opus-5`) |
| `stageModels` | `{"review": "claude-opus-4-8"}` | per-stage override (keys: spec, analyze, implement, verify, push, review, test) |
| `effort` | `"high"` | effort for every stage session — low, medium, high, xhigh, max (default `max`) |
| `stageEffort` | `{"push": "low"}` | per-stage effort override, same keys as `stageModels` |
| `design` | `{"screenshotCmd": "bash scripts/design-shot.sh", "maxMismatchPct": 10}` | design tickets: the command sessions must render with (real app, real CSS), and the highest palette-diff mismatch (default 10%) and masked share (`maxMaskedPct`, default 40%) a `score-<screen>.json` may carry before Implement/Verify refuse to pass |
| `until` | `"analyze"` | always stop after this stage |
| `push` | `false` | never push/PR — caps runs at Verify |
| `pushMode` | `"direct"` | stage 5 rebases + pushes the branch itself and stage 8 fast-forwards the base branch — no PR, no `gh`, no session. Default: PR via `gh` |
| `baseBranch` | `"main"` | the branch direct mode lands on (default: `origin/HEAD`, else `main`) |
| `branchPrefix` | `"feature"` | branch naming: `<prefix>/NNN-slug` |
| `deploy` | `{"merge":true,"cmd":"./deploy.sh","proofCmd":"./proof.sh"}` | enables stage 8 — see [Deploy](#deploy) and [Proof](#proof). Absent = 7-stage pipeline |
| `worktreeCopy` | `["local.properties", ".env", "debug.keystore"]` | exact files/dirs (typically gitignored) copied from the main repo into each run's fresh worktree at kickoff; entries already tracked in the repo are skipped; see the note below |

A run's worktree contains tracked files only. Builds that need config that is not committed
(an Android `local.properties` SDK path, `.env`, keystores, `gradle.properties`) name each file
in `worktreeCopy`; kickoff copies exactly those, skips anything already tracked (the worktree
already has the committed copy), and `autodev doctor` warns when it spots common ones untracked
and unlisted. Naming an untracked `.autodev.json` itself makes an uncommitted config effective
inside the run's worktree (a tracked `.autodev.json` is skipped the same way). Copied files are
added to the repo's shared `.git/info/exclude` (which also hides them from `git status` in your
main checkout), so autodev's own sessions cannot commit or push them: they leave the machine
only if the build itself sends them.

Env vars:

| var | default | effect |
|-----|---------|--------|
| `AUTODEV_CLAUDE_MODEL` | – | pin a model for every stage session (below `.autodev.json`, above the `claude-opus-5` default) |
| `AUTODEV_CLAUDE_EFFORT` | – | pin an effort level the same way (default `max`) |
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
- Every session runs `claude-fable-5-1` at `--effort max` unless told otherwise. Pin cheaper
  models or lower effort: `AUTODEV_CLAUDE_MODEL` / `AUTODEV_CLAUDE_EFFORT` for everything,
  or per stage in `.autodev.json` — `{"stageModels": {"push": "claude-sonnet-5"},
  "stageEffort": {"push": "low"}}` (per-stage > repo-wide > env > default).
- There is no cost ceiling. A run finishes or parks on its work — retries, the stage timeout
  and the wall clock bound it — never on its bill; `autodev cost` is the readout, not a gate.

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

## Design references

A ticket that asks for a screen usually carries a picture of it. Before the first
session starts, a run whose Jira issue has image attachments downloads them into
`.autodev/design/` in the worktree — so the Implement session is told to match
*those files, by name*, instead of matching a description of them.

Verify then treats appearance as a criterion of its own: it renders the built UI,
puts it beside each reference, and saves the side-by-side as
`.autodev/design/compare-<screen>.png`. **A design ticket cannot leave Verify
without one** — a reference with no comparison parks the run, because "it looks
right" is exactly the claim this pipeline exists not to take on trust. Those
comparison images are collected into the run's proof and attached to the ticket,
so whoever asked for the design sees both halves without checking anything out.

The `autodev-pixel-match` skill (`autodev install-skill`) carries the loop the
session follows: crop and read the reference properly, sample its colours instead
of estimating them, render the real component, screenshot it headlessly, compose
the side-by-side, name the differences, correct one, go round again.

Tickets with no attachments are unaffected — the gate stays quiet when the
directory is empty, and a Jira that cannot be reached never parks a run over it.

## Skill composition

autodev's stage prompts prefer a few Claude Code skills if you have them
installed — a GitHub-Spec-Kit-style spec skill, an execute-plan skill, a
commit/push/PR skill, a code-review skill, a systematic-debugging skill, and
`autodev-pixel-match` when the ticket carries a design —
but every stage also carries an inline fallback describing exactly what
artifact it needs, so the pipeline works with a stock Claude Code install
too. Installed skills just tend to produce better results.

## License

MIT — see [LICENSE](LICENSE).

---

### 🤝 Work with me

I'm an **AI Consultant · Forward Deployed Engineer** — I embed with teams and ship AI to production: agents, MCP integrations, and LLM features, with evals proving they work.

**→ [rohitraj.tech/en/hire](https://rohitraj.tech/en/hire)**
