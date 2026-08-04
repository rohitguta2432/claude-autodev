# Contract: Session block in `runner.log`

Satisfies FR-004 … FR-007, FR-025, FR-026.

## When it is written

On a **failed** session, and only then. A session that exits zero produces no block (FR-025).

"Failed" means the exec call threw: a non-zero exit, or `ENOENT`, `ETIMEDOUT`, `ENOBUFS`.

## Where

Appended to `$AUTODEV_HOME/runs/<id>/runner.log` — the file the runner's own stdout and stderr
already stream into. No new file, no new directory, nothing served over HTTP.

## Format

```text
--- run 1 · stage 1 (Spec) · attempt 2 · exit 1 · 1.6s · not-authenticated ---
[stdout]
…captured stdout…
[stderr]
…captured stderr…
--- end stage 1 attempt 2 ---
```

| Element | Rule |
|---|---|
| Header | Single line, opens with `--- run` — greppable and visually distinct from interleaved runner output |
| Stage | Number and title, so a block is attributable without cross-referencing |
| Attempt | 1-based within the stage |
| Outcome | `exit <n>` for a non-zero exit; the condition code (`ENOENT`, `ETIMEDOUT`, `ENOBUFS`) otherwise |
| Duration | Wall time of the session, one decimal place |
| Classification | The matched terminal condition, or omitted entirely when none matched |
| `[stdout]` / `[stderr]` | Section markers; a section with no content is omitted rather than left empty |
| Footer | Single line closing the block |

The prompt is **not** included. It is available in the source; including it would double the
cleartext footprint for a value the operator can already read, and the whole reason this feature
exists is that the prompt is not the diagnosis.

## Size cap

Each captured channel is capped at **1 MiB** in the written block: the first 200 KiB, an elision
marker naming the number of bytes dropped, then the last 800 KiB.

The tail carries the cause; the head carries the context in which the session started; the middle
is the agent reasoning at length. A runaway session must not be able to fill the operator's disk
(FR-026).

This cap is independent of the exec buffer limit, which is raised separately to 64 MiB so that a
large-but-legitimate session is not killed for being large.

## Failure is non-fatal

Writing the block MUST NOT change whether the run advances or parks (FR-007). A read-only run
directory or a full disk loses evidence; it does not lose the run. The write is wrapped and its
failure swallowed — the one place in this feature where swallowing an error is correct, because
the alternative is failing a run for the sake of its own log.

## Live readability

`runner.log` remains tailable throughout a run (FR-005). Session stderr continues to stream into
it via the exec call's default forwarding — see research R2 — and session blocks are appended as
each failure occurs, not batched at the end.
