---
name: autodev-specs
description: >-
  Produce a complete GitHub Spec Kit document set for a requirement under
  specs/NNN-slug/ — spec.md, plan.md, research.md, data-model.md,
  quickstart.md, contracts/, tasks.md and checklists/. Use when asked to
  write a spec, spec out a feature, create a Spec-Kit / spec-driven document
  set, and as autodev's stage-1 Spec skill.
---

# specs-skill — GitHub Spec Kit document set

Given a one-line requirement, create a numbered feature folder and fill it with
the full Spec Kit artifact set, in phase order. Mirror `github/spec-kit`. Write
real content grounded in the target repo — never leave a template placeholder.

## 0. Locate / create the folder
- Scan `specs/` for the highest existing `NNN-*`. New folder = next number,
  zero-padded, kebab-slug of the requirement: `specs/NNN-slug/`.
- If a complete matching spec already exists, update it in place — don't duplicate.

## 1. spec.md — the WHAT / WHY (no implementation detail)
User scenarios as stories, numbered testable functional requirements
(`FR-001 …`), key entities, and success / acceptance criteria. Mark every
ambiguity with an explicit `[NEEDS CLARIFICATION: …]`.

## 2. plan.md — the HOW (technical, always present)
Technical context (language, dependencies, storage, testing), a constitution /
gate check, the concrete project structure, and a complexity section justifying
any deviation from the simplest design.

## Phase 0 — research.md
One block per unknown or decision: **Decision / Rationale / Alternatives
considered**. Resolve every `[NEEDS CLARIFICATION]` from spec.md here.

## Phase 1 — design artifacts
- **data-model.md** — entities, fields, types, relationships, validation rules, state transitions.
- **contracts/** — one file per API / interface (OpenAPI, JSON-schema, or message shape). Omit only if the feature genuinely exposes no contract.
- **quickstart.md** — the shortest path to run and verify the feature; doubles as an integration-test script.

## Phase 2 — tasks.md
Ordered, dependency-sorted, test-first checkbox tasks (`- [ ] T001 …`) — write
the test task before its implementation task, each pointing at concrete files.
This is what downstream execution consumes.

## checklists/
At least `checklists/requirements.md`: `- [ ]` quality-gate items asserting
spec.md / plan.md / tasks.md are complete, consistent and testable. (autodev's
Analyze stage ticks these.)

## Completion gate
The set is "complete enough" once `spec.md`, `plan.md` and `tasks.md` exist and
are non-empty. Add research / data-model / quickstart / contracts / checklists
when the requirement warrants them — a data-less or contract-less feature may
legitimately omit data-model.md or contracts/.
