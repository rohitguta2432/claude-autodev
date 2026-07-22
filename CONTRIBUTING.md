# Contributing

## The bar

autodev's goal is that someone on a brand-new machine, in a brand-new Claude Code
session, can follow the README's Quickstart and get a working run — on Windows,
macOS, or Linux, without forking or patching anything.

Every change is judged against that. The useful question is not "does this work?"
but "does this survive a cold start by a stranger?"

## Setup

```bash
git clone https://github.com/rohitguta2432/claude-autodev
cd claude-autodev
npm test            # no install step — zero runtime dependencies, Node 22 stdlib only
node bin/autodev.js selftest
```

There is no build and no dependency install. If a change would add a runtime
dependency, raise it in an issue first — the zero-dependency constraint is
deliberate and load-bearing for the cold-start goal.

## Ground rules

- **Node 22 stdlib only** for runtime code (`node:sqlite`, `node:http`,
  `node:child_process`, `node:fs`). Dev-only tooling is a separate conversation.
- **Cross-platform, always.** No shell invocations, no `/bin/bash`, no POSIX-only
  paths, no extensionless executables. `execFileSync('git', [...])` rather than a
  shell string; `process.execPath` to run a Node script. `test/helpers.js` has the
  portable fixtures — use them rather than rolling your own.
- **CI must be green on all six jobs** (windows / macOS / ubuntu × Node 22 / 24)
  before a PR merges. A change that only passes on your OS is not done.
- **No timing assumptions in tests.** Poll for a condition with a generous ceiling
  and exit early when it's met. A fixed sleep that passes on a CI runner will fail
  on a contributor's laptop, which is how CI stays green while the suite is red for
  everyone else.
- **Every bug fix carries a regression test** that fails before the fix.
- **One concern per commit**, with a message that says what changed and why.

## Deferred-work markers

This codebase marks deliberate, known-and-accepted limitations with `ponytail:`:

```js
// ponytail: one level only; deeper nesting can be added when actually hit.
```

It reads as `TODO`, but narrower: it means a maintainer weighed the gap and chose
to defer it, not that someone forgot. Treat one as a decision worth re-opening
rather than a chore to silently clear — and if you do close one, delete the marker
in the same commit.

Do not add a `ponytail:` for something that is simply unfinished. If a change is
incomplete, either finish it or say so in the PR.

## Pull requests

Explain what breaks without the change — a reproduction beats a description.
If the change alters behaviour a user could be relying on, say so explicitly;
if it makes a README claim true or false, update the README in the same PR.
