---
name: autodev
description: >-
  Launch, monitor, resume, or stop a fully autonomous autodev pipeline run
  (spec → analyze → implement → verify → push → review → test → deploy in an
  isolated git worktree, live on the Mission Control dashboard), scaffold a
  repo's mission and factory rules, or run the issue-queue daemon. Use when the
  user says "/autodev", "autodev run <requirement>", "start a pipeline for X",
  "autodev status", "resume run N", "stop run N", "autodev init", or
  "start the autodev daemon".
---

# autodev — autonomous pipeline

All commands run from any directory via the globally-installed `autodev` command
(`npm install -g github:rohitgupta2432/claude-autodev`).

## Start a run
1. Confirm the target repo: `--repo <path>` argument, else the current working
   directory (must be a git repo — verify with `git rev-parse --git-dir`).
2. Run: `autodev run "<requirement>" --repo <path>`
   (from a GitHub issue instead: `autodev run --issue <n> --repo <path>`)
3. Relay the output to the user: run id, branch, worktree, dashboard URL
   (http://127.0.0.1:4590/). That's all — the run is fully autonomous.

## Set up a repo
- `autodev init --repo <path>` scaffolds `.autodev/mission.md` (goals and
  non-goals — the only thing that lets a run be REJECTED as out of scope) and
  `.autodev/factory-rules.md` (constraints binding on unsupervised sessions).
  Both are templates: tell the user they must edit them, and that an empty
  non-goals list means nothing is ever out of scope.
- Stage 8 (Deploy) is opt-in per repo via `"deploy"` in `.autodev.json`. Never
  add it on the user's behalf without asking — it merges and deploys with no
  human in the path.

## Run the queue
- `autodev daemon --repo <path> [--interval 30] [--max-parallel 2] [--auto-accept] [--once]`
  reconciles finished runs onto their issues, then starts runs for issues
  labelled `autodev:accepted`.
- `--auto-accept` labels untriaged issues automatically. Only suggest it for a
  private repo, and say plainly that it lets any issue filed there start a run.
- It runs in the foreground until stopped; `--once` does a single tick.

## Other commands
- Status: `autodev status`
- Resume a BLOCKED run: `autodev resume <id>`
  (first read `~/.autodev/runs/<id>/blocked.md` and summarize the diagnosis to the user)
- A REJECTED run is a decision, not a failure — it means the spec stage judged the
  requirement against the repo's mission and declined it. Do not resume it; report
  the reason and ask whether to narrow the requirement or edit the mission.
- Stop: `autodev stop <id>`

Never re-implement pipeline stages yourself — the runner owns them.
