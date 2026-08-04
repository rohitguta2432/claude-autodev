# Contract: Run record — `spec_dir`

Satisfies FR-019 … FR-024.

## Column

```sql
spec_dir TEXT   -- nullable
```

Added in two places, matching the existing convention exactly:

- the `CREATE TABLE IF NOT EXISTS runs (...)` statement, for fresh databases;
- the `ALTER TABLE runs ADD COLUMN` migration loop, wrapped in the same `try`/`catch` that makes
  re-running a no-op on databases that already have the column.

A database written by an earlier binary MUST open, read, and run without error. This is verified
by a test that creates a row with the pre-change column set and then opens it with the new code.

## Value

| Property | Rule |
|---|---|
| Form | Repository-relative, POSIX separators, no leading `./`, no trailing slash |
| Example | `specs/004-marketplace-storefront` |
| Absolute paths | MUST NOT be stored |
| Windows | Stored POSIX-style; converted at the point of resolution, never at the point of storage |
| Resolution | `join(run.worktree, run.spec_dir)` |
| `NULL` | Legal, and means "not pinned" |

## Write points

Exactly two, and never a rewrite:

1. **At kickoff**, when a spec directory is adopted — either the operator named one explicitly, or
   automatic word-overlap matching produced exactly one complete candidate. The run's starting
   stage is 2, as today.
2. **After stage 1's check passes**, with the directory that stage actually produced, resolved by
   the same rule the check used. Skipped when the column is already non-`NULL`.

A stage session MUST NOT be able to set this column. It is written by the runner from an
observation of the worktree.

## Resolution contract

Every consumer MUST resolve the spec directory through one shared function with this behavior:

```text
resolve(run):
  if run.spec_dir is set:
      candidate = join(run.worktree, run.spec_dir)
      if candidate exists and is a directory:
          return candidate
  return <today's behavior: highest-numbered specs/NNN-* directory in the worktree, or null>
```

Fallback is mandatory (FR-023): a recorded directory that has been deleted, renamed, or never
existed in this worktree MUST fall back, not throw and not park. A pointer must never be the
reason a run fails.

### Consumers

All of these MUST use the shared resolver — no consumer may re-implement it:

- the stage-1 artifact check;
- the stage-2 checklist gate;
- the stage-3 task-completion check;
- the stage-4 verification gate;
- the stage prompts for stages 2, 3 and 4, which MUST name the resolved directory rather than
  instructing the session to find "the newest" one (FR-022);
- the dashboard's task pane.

The prompt requirement is not cosmetic. If the instruction says "newest" while the check reads
the pinned directory, the session and its grader disagree, which is the same class of bug this
contract exists to close.

## Concurrency

Two runs against the same repository MUST NOT resolve to the same directory purely as a
consequence of resolution (FR-024). Pinning at both write points is what delivers this: run A
pins `specs/016-x` when stage 1 creates it, so run B creating `specs/017-y` a minute later cannot
pull run A's later stages onto `017`.

This is not a lock. Two runs deliberately pointed at the same spec by an operator remain the
operator's business.
