# claude-autodev

Requirement in → reviewed, tested PR out. An autonomous 7-stage dev pipeline
for Claude Code with a live mission-control dashboard.

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
npm install -g github:rohitguta2432/claude-autodev
autodev install-skill   # copies the packaged skill into ~/.claude/skills/autodev/
```

```bash
autodev run "add rate limiting to the API" --repo .
autodev status
autodev resume <id>     # after fixing whatever parked it BLOCKED
autodev stop <id>
```

Dashboard: http://127.0.0.1:4590/ — live stage/status per run, updated over SSE.

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

- Headless Claude sessions run with `--dangerously-skip-permissions`. This is
  scoped by running **inside an isolated git worktree** created just for the
  run — not your main working copy — but you should still only point autodev
  at repos and requirements you'd trust an unsupervised agent with.
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
