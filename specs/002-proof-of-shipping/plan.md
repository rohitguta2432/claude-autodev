# Implementation Plan: Proof of Shipping

**Spec**: [spec.md](./spec.md)

## Technical approach

One new module, `src/proof.js`, owns three things: where evidence lives (`proofDir`), how it
gets there (`collectProof`, `proofFiles`, `gatherProof`) and how it is reported (`proofReport`
pure over `(run, proof)`, `proofAdf` to Atlassian document format). Runner and queue call into
it; neither grows logic of its own.

### Runner (`src/runner.js`)

- Before each stage, snapshot `proof/` names. After the stage's checks, `collectProof` for the
  stage key, diff against the snapshot, emit `proof` with the new names. The diff — not the copy
  list — is what gets reported, so files the proof command wrote are included.
- `deployStage`: `prState()` via `gh pr view --json state,mergeCommit`. `MERGED` → record and
  skip. Otherwise merge, then read the state again for the commit. Emit `merged`. Time the
  deploy command; emit `deployed` with `cmd · exit 0 · Ns`. Then `proofCmd` with
  `AUTODEV_PROOF_DIR`/`AUTODEV_RUN`, output to `proof-output.txt` in the run dir, park on
  non-zero exit or on no new file.

### Queue (`src/jira-queue.js`)

- `outcomeFor(run, proof)` returns `{ done, body }` where `body` is ADF. `DONE` uses
  `proofReport` + `proofAdf`; blocked/rejected keep their sentence, wrapped as a paragraph.
- `attachProof(cfg, key, runDir)` uploads each `proof/` file ≤ 10 MiB with
  `FormData`/`Blob` (Node 22 stdlib) and `X-Atlassian-Token: no-check`; throws on the first
  failure.
- Reconcile order for `DONE`: attach → comment → transition (if not already done) → mark
  notified.

### Tests

- `test/proof.test.js`: collection copies what exists and skips what does not; the report says
  "not deployed" without a `deployed` event and names the commit/command with one; ADF carries
  the link, the bullet facts and the deploy tail.
- `test/jira-queue.test.js`: a local `node:http` stub Jira records requests. A `DONE` run with
  two proof files → two multipart POSTs, one comment whose ADF names both files, one
  transition, in that order, and `notified` set. A stub that fails the upload → no comment, no
  transition, not notified, error in the tick log.
- `test/factory.test.js`: `proofCmd` success (file in `proof/`, `deployed`+`proof` events) and
  failure (parks at 8, reason names the proof command); the existing deploy test also asserts
  `proof/deploy-output.txt` and `proof/test-output.txt`.

### Docs

README: Deploy section gets `proofCmd` and a "Proof" paragraph; configuration table row.
CHANGELOG: entry under Unreleased.

## Files

| file | change |
|------|--------|
| `src/proof.js` | new |
| `src/runner.js` | collect after stages; deploy events, idempotent merge, `proofCmd` |
| `src/jira-queue.js` | ADF outcome, attachments, reconcile order |
| `test/proof.test.js`, `test/jira-queue.test.js` | new |
| `test/factory.test.js` | proof assertions |
| `README.md`, `CHANGELOG.md` | docs |
