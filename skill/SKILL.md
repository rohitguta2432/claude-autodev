---
name: autodev
description: >-
  Launch, monitor, resume, or stop a fully autonomous autodev pipeline run
  (spec → analyze → implement → push → review → test in an isolated git
  worktree, live on the Mission Control dashboard). Use when the user says
  "/autodev", "autodev run <requirement>", "start a pipeline for X",
  "autodev status", "resume run N", or "stop run N".
---

# autodev — autonomous pipeline

All commands run from any directory via the globally-installed `autodev` command
(`npm install -g github:rohitgupta2432/claude-autodev`).

## Start a run
1. Confirm the target repo: `--repo <path>` argument, else the current working
   directory (must be a git repo — verify with `git rev-parse --git-dir`).
2. Run: `autodev run "<requirement>" --repo <path>`
3. Relay the output to the user: run id, branch, worktree, dashboard URL
   (http://127.0.0.1:4590/). That's all — the run is fully autonomous.

## Other commands
- Status: `autodev status`
- Resume a BLOCKED run: `autodev resume <id>`
  (first read `~/.autodev/runs/<id>/blocked.md` and summarize the diagnosis to the user)
- Stop: `autodev stop <id>`

Never re-implement pipeline stages yourself — the runner owns them.
