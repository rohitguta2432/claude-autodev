# Quickstart: validating First Green Run

How to prove each user story, and how to prove the whole feature. Every check below runs offline
and spends no quota except the final end-to-end run, which is explicitly marked.

## Prerequisites

```bash
node --version      # must be >= 22.5
git --version
```

Working from a clone of this repository:

```bash
npm test
```

The suite must be green before and after. `test/helpers.js` already provides the mechanism every
check below relies on: `stubClaude(dir, jsBody)` writes a Node script whose path goes into
`AUTODEV_CLAUDE_BIN`, and the runner executes a `.js` value there via `process.execPath` — no
shell, portable on all three platforms.

---

## US3 — The runner starts on every supported machine

The regression this guards is invisible by construction: a background process that dies
immediately leaves a run that says `RUNNING` forever.

**Automated**: assert that no launch site passes a bare interpreter name.

```bash
grep -rn "spawn('node'" src bin        # must return nothing
grep -rn 'spawn("node"' src bin        # must return nothing
```

**Manual**, on a machine whose interpreter is not reachable by name:

```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin "$(which node)" bin/autodev.js run "trivial change" --repo /tmp/fixture-repo --no-push
autodev status                          # the run must leave stage 1
```

Expected: the run advances. Before the change, it sits at `RUNNING` stage 1 with an empty
`events.jsonl` and a stack trace in `runner.log`.

---

## US1 — A parked run states the real failure

Drive a session that fails with a known, recognizable message.

```bash
node --test test/runner.test.js
```

The relevant cases assert, against [contracts/park-reason.md](./contracts/park-reason.md):

1. `blocked_reason` contains the message the stub printed.
2. `blocked_reason` contains **no** non-trivial substring of the stage prompt — this is SC-001,
   checked mechanically rather than by eye.
3. Both `retry` events carry the same real reason, not the prompt.
4. `runner.log` contains a session block matching
   [contracts/session-log.md](./contracts/session-log.md), attributed to the stage and attempt.
5. A stub whose output exceeds the old 1 MiB buffer completes normally rather than parking with
   an unrelated failure.

**Manual read-through** — the SC-002 check, which no test can make for you. Park a run, then,
knowing only its id:

```bash
cat ~/.autodev/runs/<id>/blocked.md
tail -40 ~/.autodev/runs/<id>/runner.log
```

You must be able to name the cause and the remedy from those two files, without opening the
worktree or reading source.

---

## US2 — An unrecoverable failure stops after one session

```bash
node --test test/runner.test.js
```

Per [contracts/terminal-conditions.md](./contracts/terminal-conditions.md), the cases assert:

- each of the three conditions produces **exactly one** session — counted by the stub, not
  inferred from the reason;
- the reason names the remedy, not only the symptom;
- an *unmatched* failure still makes the full complement of attempts (fail-open);
- a session that exits **zero** while its output contains a matching phrase neither parks nor
  classifies;
- two conditions present simultaneously resolve to the earlier one in the fixed order.

The session count is the assertion that matters. A test that only reads the reason would pass
while the run still burned three sessions.

---

## US4 — A resumed stage knows what failed last time

```bash
node --test test/runner.test.js
```

Cases:

1. Park a run with a known reason; resume; the stub records the prompt it received, and that
   prompt contains the previous reason.
2. The seeded attempt succeeds → no further attempts, and the run advances.
3. Resume a run that was never parked → the prompt contains no previous-failure text.
4. Resume twice → the second resumed prompt carries one reason, not two concatenated.

---

## US5 — The run works the spec it was given

```bash
node --test test/stages.test.js test/cli.test.js test/db.test.js
```

Cases, against [contracts/run-record.md](./contracts/run-record.md):

- a fixture repository holding `specs/001-*`, `specs/002-*` and `specs/015-*`, all complete;
  adopting `001` records `specs/001-…` and every later stage reads it, not `015`;
- automatic word-overlap adoption records the same way as an explicit choice;
- a fresh run whose stage 1 creates a directory records what it created;
- a recorded directory absent from the worktree falls back rather than parking;
- a row written without the column opens, reads and runs unchanged;
- the stored value is POSIX-form and repo-relative on all platforms.

---

## Whole-feature regression

```bash
autodev selftest
```

Drives a fixture repository through all seven stages against the pipeline stub. No quota. It must
stay green — it is the canary for the exec path, and a break here means `runClaude`'s success
path changed when only its failure path should have.

---

## SC-008 — one real green run

The success criterion the project has never met. This one **does** spend quota.

```bash
autodev doctor --repo <a real, small repository>
autodev run "<a small, genuinely useful change>" --repo <that repository> --no-push
autodev status
autodev cost <id>
```

Expected: the run reaches its ceiling stage with `DONE`, having produced a spec, an
implementation, a passing verification, and a green test command. `--no-push` keeps the first
attempt off any remote; drop it once a run has finished cleanly.

If it parks, the feature has already done its job: `blocked.md` should tell you why in one line,
and `autodev resume <id>` should carry that reason into the retry. Record what parked it — that
observation is the evidence any fourth terminal condition would need.
