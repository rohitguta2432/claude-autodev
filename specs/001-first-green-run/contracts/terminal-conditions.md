# Contract: Terminal conditions

Satisfies FR-008 … FR-012.

A **terminal condition** is a session failure that cannot succeed on retry. When one is
recognized, the run parks on the first occurrence instead of consuming its retry budget.

## The enumerated set

Exactly three. The set is closed; adding a fourth requires evidence from an observed run.

| # | Condition | Detection | Applied |
|---|---|---|---|
| 1 | Coding CLI cannot be found or launched | **Structural** — the exec error's `code` is `ENOENT` | First |
| 2 | Coding CLI is not authenticated | Text match on the session's combined stdout + stderr | Second |
| 3 | Usage allowance exhausted | Text match on the session's combined stdout + stderr | Third |

Order is fixed so that a session whose output somehow matches more than one classifies
deterministically — required by the spec's edge cases. `ENOENT` is first because it is
structural: it cannot be confused with content the session merely printed.

## Remedy text

Each condition carries a remedy, not just a name (FR-010). The remedy is folded into the park
reason so that the operator reads cause and fix in one line:

| Condition | Reason names |
|---|---|
| Not found | The binary that could not be launched, and that it must be installed or its path configured |
| Not authenticated | That the CLI is installed but signed out, and that one interactive session records the credential |
| Allowance exhausted | That the allowance is spent, and that the run can be resumed once it resets |

## Rules

**R1 — Only failed sessions are classified** (FR-012). A session that exits zero is never
inspected. A model that quotes an authentication error while reasoning about it cannot park a run.

**R2 — Fail open** (FR-011). An unmatched failure keeps today's behavior exactly: it is retried
up to the existing cap and then parks. Classification may only ever *shorten* the path to a park
that was going to happen anyway; it may never convert a recoverable failure into a park.

**R3 — Transient failures are excluded.** Rate limiting is specifically not part of condition 3.
A rate limit is precisely what retries exist for. Folding it in would violate R2.

**R4 — Matching is anchored to tool output, not prose.** Patterns target the phrasing that
appears in CLI error output rather than words a model might use conversationally.

**R5 — Classification sets the existing final-failure flag.** No new control flow: the stage loop
already breaks out of its retry loop when a thrown error carries that flag. Classification
attaches it; nothing else changes.

**R6 — Classification is not persisted.** It is expressed in the reason string and in the flag,
and then discarded. A database column recording it would create a second description of the
failure, free to disagree with the first.

## Asymmetry, stated plainly

The cost of a **missed** classification is the status quo: three attempts, then a park.
The cost of a **wrong** classification is a run parked that would have succeeded.

The second is worse, so every ambiguous case defaults to not classifying. This asymmetry is why
the set is three and not thirty.

## Test obligations

- Each of the three conditions parks after exactly one session — asserted by counting sessions,
  not by reading the reason.
- An unmatched failure still makes the full complement of attempts.
- A session that exits **zero** while its output contains a matching phrase does not park and
  does not classify.
- Two conditions present at once resolve to the earlier one in the fixed order.
