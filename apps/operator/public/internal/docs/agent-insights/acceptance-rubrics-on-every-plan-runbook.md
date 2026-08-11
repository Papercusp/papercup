# Acceptance rubrics on every plan — authoring + grading runbook
URL: /internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook

Runbook for the plan-completion acceptance gate: every plan ships with a kind:'acceptance' rubric authored AFTER implementation and graded by a non-implementer; covers the rubric kind field, the propose/grade/ship flow, gate refusal codes, exemptions, and the four plan-class rubrics.

## The model (owner-ruled 2026-08-11)

Every plan carries a gradeable definition of done as a REAL rubric — a `template:'rubric'` plan whose `template_data.kind` is `'acceptance'` — not an embedded plan section and not a parallel grading mechanism. The one enforcement point is COMPLETION: `plans:set-plan-status → 'shipped'` (and its `done` alias) refuses without a graded acceptance rubric. There is deliberately NO gate at `plans:new` / `plans:start`.

Timing is post-implementation BY DESIGN (plan D-007, superseding the TDD-style instinct): the rubric does not exist until the work is done, so it is authored against as-built reality — better informed, and no tokens are spent on criteria a mid-implementation redesign would invalidate. The honesty guard is at grading, not authoring: the GRADER must not be the rubric's author (D-005), and the grader's first check is coverage — criteria must trace to the plan's stated GOAL + Decisions, never merely describe the diff.

## The kind field

`rubric-template.ts` validates `kind: 'standard' | 'acceptance'` (absent = `standard`; every pre-kind rubric is unchanged).

|                                    | standard                                | acceptance                                                                                  |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| semantics                          | reusable shared-standards library entry | one-shot per-plan definition of done                                                        |
| default `rubrics:list/search`      | ✅ shown                                 | hidden (`kind:'acceptance'`/`'any'` opts in)                                                |
| ratification                       | Queen ratifies (propose → draft)        | none — ACTIVATES on propose (D-008)                                                         |
| staleness watchdog / releaseGating | watched / allowed                       | exempt / refused                                                                            |
| links                              | none                                    | `subjectPlan` REQUIRED (validated to exist); optional `classRef` to a standard class rubric |
| criteria                           | ≥1, full model/method/driftMarkers      | 3–7 light criteria (model/method optional); may be EMPTY with a `classRef` (D-009)          |
| lifecycle                          | until retired                           | auto-retired when the subject plan ships                                                    |

`getRubric(id)` resolves ANY kind (an explicit id is an explicit opt-in), so the shared grading path (`scorecards:emit` → `listScorecards`) works unchanged (D-010). `getAcceptanceRubricForPlan(planSlug)` is the subject-plan lookup the gate and `plans:get` use — `plans:get` (sections/full) surfaces `acceptanceRubric` when one exists.

## The flow (implementer, then grader)

1. Implement the plan; verify it for real.
2. **Author** (implementer, post-implementation): `rubrics:propose { kind:'acceptance', subjectPlan:'<plan-slug>', classRef:'plan-class-feature-ship'|'plan-class-bugfix'|'plan-class-migration'|'plan-class-investigation', criteria:[3–7 OUTCOME criteria tracing to the plan's goal + Decisions] }`. Dangling `subjectPlan` is refused; a rubric-template plan as subject is refused (no rubric-of-a-rubric). Investigation-only plans may pass `criteria: []` with `classRef:'plan-class-investigation'`.
3. **Grade** (a NON-implementer — different agent or the owner): `scorecards:emit { rubricRef:'<the acceptance rubricId>', ratings:{ <every criterion key>: { rating, evidence } } }`. A complete, non-synthesized scorecard whose `createdBy` ≠ the rubric's `proposedBy` satisfies the gate.
4. **Ship**: `plans:set-plan-status { slug, status:'shipped' }` — on success the acceptance rubric is auto-retired (`acceptanceRubricRetired` in the result).

## Gate refusal codes (evaluatePlanAcceptanceGate)

* `acceptance_rubric_missing` — no acceptance rubric names this plan; the message carries the propose recipe.
* `acceptance_ungraded` — rubric exists, no complete scorecard.
* `self_graded_only` — only the author has graded it (the self-graded-homework guard).

Exemptions (satisfied without a rubric): flag `ACCEPTANCE_RUBRIC_COMPLETION_GATE` off; the plan IS a rubric-template plan; scheduled template instances (`template_slug` set).

## The four class rubrics

Seeded first-party (repo `rubrics/plan-class-*`, standard-kind, characteristic `plan-acceptance`): `plan-class-feature-ship`, `plan-class-bugfix`, `plan-class-migration`, `plan-class-investigation`. They encode the shared invariants ONCE (tests-with-feature, flag-ON default, gate-green shipped, root-cause + recurrence guard, migration hygiene, writer-read findings) so per-plan bespoke criteria stay short — reference one via `classRef` instead of restating them.

## Amending

`rubrics:amend` round-trips kind/subjectPlan/classRef (dropping them would flip an acceptance rubric to standard — the WI-4287 loss class on identity fields). `rubrics:ratify` REFUSES acceptance rubrics with a teaching error.
