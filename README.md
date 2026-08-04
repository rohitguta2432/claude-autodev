# claude-autodev

[![CI](https://github.com/rohitguta2432/claude-autodev/actions/workflows/ci.yml/badge.svg)](https://github.com/rohitguta2432/claude-autodev/actions/workflows/ci.yml)

Requirement in → reviewed, tested PR out. An autonomous 7-stage dev pipeline
for Claude Code with a live mission-control dashboard.

Supported platforms: Linux, macOS, and Windows — the test suite runs on all
three (Node 22 and 24) in CI on every push.

## Why

Give it a one-line requirement and a git repo. It works the whole path —
spec, plan, implementation, verify, push, review, test — in an isolated git worktree,
retrying and self-fixing along the way, and parks itself with a diagnosis
when it truly gets stuck. You watch (or don't) on a dashboard; you get a PR.

## How it works

Each stage runs a headless Claude Code session and only advances once it
produces the artifact the next stage needs — no artifact, no advance.

| # | Stage | Gate (artifact check) |
|---|-------|------------------------|
| 1 | Spec | `specs/NNN-slug/{spec,plan,tasks}.md` all non-empty |
| 2 | Analyze | every `- [ ]` in `checklists/*.md` ticked |
| 3 | Implement | every task in `tasks.md` ticked, worktree clean (committed) |
| 4 | Verify | `.autodev/verify.json` verdict is `PASS` (no critical/high findings) |
| 5 | Push | branch has an upstream remote (opens the PR with `gh pr create`) |
| 6 | Review | `.autodev/review.json` verdict is `APPROVE` (loops fix ⇄ re-review) |
| 7 | Test | the repo's own test command exits 0 (auto-detected, or fixed and retried) |

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
autodev run "add rate limiting to the API" --repo .
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
