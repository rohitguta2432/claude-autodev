# Data Model: First Green Run

Three shapes change or gain meaning: the **run record**, the **session block** appended to a
run's log, and the **park record**. One column is added; nothing is removed or renamed.

---

## Run record (`runs` table)

The registry lives at `$AUTODEV_HOME/autodev.db`. One row per run. Columns as they stand today,
with the single addition marked:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | Also the run's display number and the `NNN` in its branch and worktree |
| `slug` | TEXT NOT NULL | Derived from the requirement (or the Jira summary) |
| `repo` | TEXT NOT NULL | Basename of the target repository |
| `repo_path` | TEXT NOT NULL | Absolute path to the target repository |
| `worktree` | TEXT NOT NULL | Absolute path to this run's git worktree |
| `branch` | TEXT NOT NULL | Branch this run owns |
| `requirement` | TEXT NOT NULL | What the operator asked for |
| `status` | TEXT NOT NULL | `RUNNING` \| `BLOCKED` \| `DONE` |
| `stage` | INTEGER NOT NULL | 1–7 |
| `pid` | INTEGER | The owning runner process |
| `pr_url` | TEXT | Set when the push stage opens a pull request |
| `blocked_reason` | TEXT | **Meaning changes** — see [contracts/park-reason.md](./contracts/park-reason.md) |
| `jira_key`, `issue_type` | TEXT | Jira mode |
| `skipped` | TEXT | Comma-joined stage numbers skipped from the dashboard |
| `test_cmd` | TEXT | Test-stage override from the CLI |
| `until_stage` | INTEGER | Hard stop after this stage |
| **`spec_dir`** | **TEXT, nullable** | **NEW** — repo-relative POSIX path of the spec directory this run owns |
| `created_at`, `updated_at` | INTEGER NOT NULL | Epoch milliseconds |

### `spec_dir`

- **Value**: a repository-relative path in POSIX form, e.g. `specs/004-marketplace-storefront`.
  Never absolute, never OS-native separators — it identifies a location inside a repository, not
  on a filesystem, and must survive a worktree that lives somewhere else.
- **Resolution**: `join(run.worktree, run.spec_dir)`.
- **Nullable by design**. `NULL` means "not pinned" and every consumer falls back to today's
  behavior. Rows written by an earlier binary have `NULL` and must keep working unchanged.
- **Written twice at most**, never rewritten after:
  1. At kickoff, when a spec is adopted — explicitly via the operator's choice, or by automatic
     word-overlap match. The run also starts at stage 2 in this case, as it does today.
  2. Immediately after stage 1's check passes, with the directory that stage actually created.
     Skipped when the column is already set.
- **Never written by a stage session.** It is set by the runner from what it observes on disk,
  not from anything a session reports. This keeps Principle III intact — the pin is an
  observation, not a self-report.

### State transitions

```text
                    kickoff
                       │
                       ▼
                   RUNNING ──────── all stages pass ────────▶ DONE
                    │   ▲
       stage        │   │
       exhausts     │   │  resume  (blocked_reason captured, then cleared;
       retries, or  │   │           seeded into the resumed stage's first attempt)
       terminal     ▼   │
       condition   BLOCKED
```

Invariants across the transition:

- Entering `BLOCKED` always sets `blocked_reason` to a non-empty string satisfying the park-reason
  contract.
- Leaving `BLOCKED` via resume clears `blocked_reason`, but only **after** the runner has read it.
  Reading before clearing is the whole of user story 4.
- A `DONE` run's `blocked_reason` is whatever its last park left; nothing clears it on success,
  and nothing reads it there.

---

## Session block (appended to `runner.log`)

Written to `$AUTODEV_HOME/runs/<id>/runner.log` when, and only when, a session fails. Format and
size cap are specified in [contracts/session-log.md](./contracts/session-log.md). Shape:

| Field | Source |
|---|---|
| Run id, stage number, stage title | Runner state at the moment of failure |
| Attempt number | The stage's retry counter, 1-based |
| Outcome | Exit status, or the condition code for a non-exit failure (`ENOENT`, `ETIMEDOUT`, `ENOBUFS`) |
| Duration | Wall time of the session |
| Classification | The terminal condition matched, or absent |
| stdout | Captured from the failed session, size-capped |
| stderr | Captured from the failed session, size-capped |

Not persisted anywhere else. `runner.log` is a derived artifact — deleting it loses evidence, not
state. Nothing reads it programmatically; it exists for a human and for `tail -f`.

---

## Park record (`blocked.md`)

Unchanged in structure. Written to `$AUTODEV_HOME/runs/<id>/blocked.md` on every park, containing
the run id, the stage, the reason, and a trailing slice of the last output.

What changes is its content quality, and it changes for free: the reason it prints is
`blocked_reason`, and the last-output slice now receives **both** channels of the failed session
rather than stdout alone.

---

## Terminal condition (not persisted)

A value, not a record. Produced by classification, consumed immediately, and expressed in two
places: the `final` flag on the thrown error, and the remedy text folded into the reason string.
It is deliberately **not** a database column — persisting a classification would create a second
place where the failure is described, free to disagree with `blocked_reason`.

The enumerated set is specified in
[contracts/terminal-conditions.md](./contracts/terminal-conditions.md).
