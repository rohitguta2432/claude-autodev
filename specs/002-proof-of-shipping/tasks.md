# Tasks: Proof of Shipping

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [x] T001 [US2] `src/proof.js`: `proofDir`, `collectProof`, `proofFiles`, `readEvents`, `gatherProof`.
- [x] T002 [US1] `src/proof.js`: `proofReport` (pure) and `proofAdf`/`adfDoc`/`adfParagraph`.
- [x] T003 [US2] `src/runner.js`: snapshot→collect→`proof` event around every stage.
- [x] T004 [US3] `src/runner.js` `deployStage`: `prState`, skip when `MERGED`, `merged` and `deployed` events, `proofCmd` with `AUTODEV_PROOF_DIR`, park on failure or no evidence.
- [x] T005 [US1] `src/jira-queue.js`: `outcomeFor(run, proof)` → ADF; `attachProof`; reconcile attach→comment→transition.
- [x] T006 [US1][US2] `test/proof.test.js`: collection and report.
- [x] T007 [US1] `test/jira-queue.test.js`: stub Jira; order and failure path; `dispatchPlan`.
- [x] T008 [US3] `test/factory.test.js`: `proofCmd` success/failure; proof files after deploy.
- [x] T009 README Deploy/Configuration; CHANGELOG.
- [x] T010 `npm test` green (was 124 passing before the change).
