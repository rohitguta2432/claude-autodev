# Feature Specification: Opus at Max Effort by Default, No Cost Ceiling

**Feature Branch**: `main`

**Created**: 2026-09-03

**Status**: Implemented

**Input**: Rohit, watching run #5 (SCRUM-46) park at the review stage with
"cost budget exceeded: $2.00 spent >= maxCostUsd $1 (.autodev.json) — raise it and resume":
"remove this validation … there should be no validation", and "also make opus 5 model max
effort default".

## Context

Two defaults were tuned for a cautious first user and are wrong for this operator:

1. **`maxCostUsd`** parked a run the moment the next session would start beyond the ceiling.
   Run #5 had built, verified and pushed a change and was one review round from done; the park
   threw that position away for a dollar. The operator's position is that a run should finish
   or fail on its work, never on its bill — spend is visible per stage on the dashboard and via
   `autodev cost`, which is the control they want.
2. **The session model** fell through to the `claude` CLI default (Sonnet 5 on this machine),
   at the CLI's default effort. Every run so far spent its tokens on the cheaper model. An
   unattended pipeline is the wrong place to economise on reasoning: a weaker session that
   parks costs a resume and an operator's attention, which is the expensive resource.

## Requirements

- **FR-001** The runner MUST NOT refuse or park a session on accumulated cost. `maxCostUsd` in
  `.autodev.json` is no longer read; per-stage cost reporting (`metrics` events, `autodev cost`)
  is unchanged.
- **FR-002** Every stage session MUST be started with `--model` and `--effort`, resolved through
  the one precedence chain: per-stage (`stageModels` / `stageEffort`) > repo-wide (`model` /
  `effort`) > env (`AUTODEV_CLAUDE_MODEL` / `AUTODEV_CLAUDE_EFFORT`) > built-in
  (`claude-opus-5` / `max`).
- **FR-003** Docs (README configuration table, cost section, troubleshooting) and the
  constitution's Budgets clause MUST describe the new behaviour.

## Acceptance

1. A run whose sessions each report $2 against `{"maxCostUsd": 1}` exhausts its retry budget on
   the missing artifact and is parked for that reason, with `autodev cost` showing every session.
2. `modelFor({}, 'spec')` is `claude-opus-5`; `effortFor({}, 'spec')` is `max`; both honour
   the per-stage, repo and env overrides above.

## Constitution check

- **V (one precedence chain)**: `effort`/`stageEffort` slot in beside `model`/`stageModels`
  with the same resolution order, documented at the resolution site in `src/config.js`.
- **Runtime constraints → Budgets**: amended in the same change — the retry, review-loop,
  stage-timeout and wall-clock budgets remain; the cost ceiling is removed by decision, not by
  omission.

## Consequence spelled out

Without a ceiling, a run's spend is bounded only by the retry budget, the 45-minute stage
timeout and the 6-hour wall clock. On Opus at max effort a full run costs several times what
the Sonnet runs did. The operator has accepted this; `autodev cost <id>` remains the readout.
