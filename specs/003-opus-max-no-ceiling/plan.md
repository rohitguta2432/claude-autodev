# Implementation Plan: Opus at Max Effort by Default, No Cost Ceiling

**Spec**: [spec.md](./spec.md)

- `src/runner.js` `runClaude`: delete the `maxCostUsd` guard; always pass `--model` and
  `--effort` (resolved by `modelFor` / `effortFor`). The `costUsd` accumulator stays — it feeds
  nothing now except the metrics events already emitted per session, and removing it would be
  a second concern.
- `src/config.js`: `DEFAULT_MODEL = 'claude-opus-5'`, `DEFAULT_EFFORT = 'max'`; `modelFor`
  falls through to the default instead of `null`; new `effortFor` with the same chain.
- `test/config.test.js`: defaults and overrides for both. `test/runner.test.js`: the cost test
  becomes "spend never parks a run" — same $2 stub, asserts the park reason is the missing
  artifact and that all three sessions ran.
- README: configuration table (`model`, `effort`, `stageEffort`; drop `maxCostUsd`), cost
  section, troubleshooting row. Constitution Budgets clause. CHANGELOG.

One commit: both edits land in the same two lines of `runClaude`, and splitting them would
mean committing a runner that passes `--model null`.
