# Contract: Park reason

Satisfies FR-001 … FR-003. This contract is what makes SC-001 mechanically checkable.

## The single string

One string describes why a run stopped. It is stored as `blocked_reason` on the run record, and
it reaches every reporting surface from there:

- `blocked.md` in the run directory,
- the `parked` event in `events.jsonl`,
- `autodev status`,
- the dashboard's blocked banner and stage badge,
- the `retry` events emitted between attempts.

Because they all read the same value, they cannot disagree. Any future surface reporting a
failure MUST read this value rather than deriving its own.

## MUST NOT contain

- **Any portion of the stage instruction given to the session.** This is the defect being fixed
  and the invariant that must hold under every failure mode: non-zero exit, binary not found,
  timeout, and output overflow.
- The full command line of the session.
- A stack trace from the harness.

The non-zero-exit case is the one that violates this today, because Node's error message for that
case is `Command failed: <full argv>` and the prompt is an argument.

## MUST contain

For a **session failure**: content drawn from what the session actually produced — the last lines
of its combined output that carry information. Blank and decorative lines are skipped.

For a **classified terminal condition**: the condition and its remedy, not the symptom alone.
"Not signed in — run `claude` once interactively to authenticate" rather than an exit code.

For a **non-exit failure**: the condition by name — the stage timed out, the binary could not be
found, the output exceeded the buffer. These messages already avoid echoing argv and need only be
passed through rather than replaced.

For a **session that produced no output at all**: the stage, the attempt, and the exit status.
Never a fallback to the instruction.

For a **gate failure** (a stage whose check rejected its artifact): unchanged from today. These
messages are already written by the project and are already meaningful — `review verdict:
REQUEST_CHANGES`, `unchecked task remains: T007`, `branch has no upstream — push failed`.

## Shape

| Property | Rule |
|---|---|
| Length | Truncated to 300 characters wherever stored |
| Truncation | MUST NOT remove the identifying part of the failure — truncate the trailing context, keep the head of the constructed reason |
| Whitespace | Collapsed; no embedded newlines |
| Emptiness | MUST NOT be empty when `status` is `BLOCKED` |

## Evidence

The reason is a summary, not the whole story. Supporting evidence lives in the same run
directory:

- `blocked.md` carries a trailing slice of the failed session's output — now **both** channels,
  where today it receives stdout alone;
- `runner.log` carries the delimited session block, per
  [session-log.md](./session-log.md).

An operator holding only a run id MUST be able to reach cause and remedy from these files alone,
without opening the worktree (SC-002).

## Test hook

SC-001 is checked, not asserted: for every park path the suite exercises, the test compares the
resulting `blocked_reason` against the stage prompt that produced it and fails if any
non-trivial substring of the prompt appears in the reason.
