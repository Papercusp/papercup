# Plan authoring checklist: plans that do not stall at their last items
URL: /internal/docs/agent-insights/plan-authoring-checklist-plans-that-do-not-stall

Twelve working rules for writing a plan and its test criteria so it does not stall at its final items, with the evidence from two stalled release plans. plans:new returns the same twelve lines with any refusal; plans:add-decision advises when a plan passes its size budget.

## What

Twelve rules for writing a plan and its test criteria. They come from an analysis, on 2026-11-13, of two release plans that built quickly and then stopped at their last items: the P2P release plan and the Slack/Asana bug-fix PR plan. Full analysis: report `rpt_5f9faea4-4389-4070-82dd-160b59f65423` (Reports reader, `/reports?sel=rpt_5f9faea4-4389-4070-82dd-160b59f65423`).

The rules are advice. No tool enforces them. Two tools deliver them at the moment they can still change the plan:

* `plans:new` returns the twelve lines as `authoringChecklist` with any refusal. A refusal is when the author is about to send the plan body again.
* `plans:add-decision` returns `planSizeAdvisory` when the plan is past its size budget. The decision is still recorded.

The source of the twelve lines is `packages/operator-core/lib/agent-tools/plans/plan-authoring-checklist.ts`. Change the rules there, not in this page.

## Why it matters

Both plans showed the same shape.

| Pattern                                                                            | P2P                                                 | Slack/Asana                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| Build finishes early, then a long tail                                             | 22 of 31 closures in week one                       | 8 of 10 closures in two days                               |
| The last item is one big real-world run that depends on things outside the feature | 29 requirements, one frozen build, one physical rig | The whole release gate green on a stale drill copy         |
| A failed run adds gates instead of a fix                                           | Tooling items placed in front of acceptance         | Fork-base rules, admission pre-checks, four more decisions |
| Decisions used as a work log                                                       | 354 decisions, 965 KB                               | 85 decisions, 197 KB                                       |
| Many hands, stale status text                                                      | 53 worked-by entries; no driver for five days       | 49 worked-by entries; status text 16 days old              |
| The owner restarted it by hand                                                     | Twice                                               | Twice                                                      |

The work that stalls is the last tenth. It stalls because the final proof is slow, depends on systems the feature does not own, and cannot be repeated before the rest of the acceptance evidence goes stale.

## How to apply

Check a draft plan against each line before you ask for review.

1. **For each requirement, name the cheapest place it can be proven and prove it there.** A requirement goes on the live plane only when no test can show it. A live requirement costs a deploy and a real run every time it is re-checked.
2. **The first item proves the last item's route.** The right project, an identity allowed to act there, a worker that can take the task, and the running build read back. If the route is broken, you learn it on day one instead of at acceptance.
3. **A live pass condition names the running build that must contain the change and how that is read.** Passing tests in the working tree is not that.
4. **No final item whose pass depends on systems outside the feature.** If a drill needs a gate, a rig or a fork, say which failures count as the feature's. Otherwise every unrelated failure blocks the plan.
5. **At most seven requirements per release.** More means two releases. The P2P plan carried 29 into one acceptance run.
6. **Proof must be re-runnable in minutes.** If it is not, building the fast version is item one. Proof that takes a rig or a full gate run cannot be refreshed just before grading, so it expires while the rest is assembled.
7. **A failed acceptance run creates a fix item, never a new prerequisite.** Both plans answered failures with more gates in front of acceptance.
8. **Decisions are rulings. Step-by-step notes go on work items.** A plan past the size budget gets split or replaced. The budget is `PLAN_SIZE_BUDGET` in `plan-size-advisory.ts` (30 decisions or 100 KB when this page was written), which is about the largest tenth of plans that carry decisions.
9. **The last item never bundles summary, grading, audit, deploy and ship.** One bundled item hides which step is stuck.
10. **Every plan names its driver, a backup, and what happens when the driver is silent for 24 hours.** Both plans sat for days with nobody driving.
11. **Nobody waits on an absent author.** The driver repairs the test after a set time and a non-implementer reviews it afterwards.
12. **Before proposing a plan, list the open plans in the same area and extend one if it fits.** `plans:new` checks similarity at creation; this rule covers the proposal that comes before.

## What the tools do

**`plans:new` reports every problem in one refusal.** It used to return as soon as one check failed, so an author met the problems one per attempt and sent the whole plan body each time. Creating one small draft took four calls: no requirement records, then no Bar-to-work map, then a similar plan that needed `force: true`. Now every check runs before anything is returned.

* `problems` lists each problem as `{ check, code, detail }`. `check` is `item-grammar`, `acceptance-bar`, `property-schema` or `similar-plans`.
* `error` and `reason` are those of the first failing check, so `similar_exists`, `invalid_plan_content` and `bad_property_schema` still mean what they did.
* Each failing check's detail block is present: `parseFeedback`, `acceptanceBar`, `issues`. The similar-plan block is top-level when it is the only problem and under `similarPlans` otherwise.
* `authoringChecklist` carries the twelve lines and a link to this page.

**`plans:add-decision` advises on size.** Past 30 decisions or 100 KB the result carries `planSizeAdvisory` with the measured size, which line was passed, and the two calls for a step-by-step note: `work_items:checkpoint { id, checkpoint }` for current state and `work_items:comment { id, body }` for a running log. It never refuses.

## Evidence

* Pattern table: report `rpt_5f9faea4-4389-4070-82dd-160b59f65423`, section 2, measured 2026-11-13.
* Size budget: 1,306 unarchived plans with at least one decision, measured 2026-11-13 from `harness_shared.harness_plans`. Decisions p50 7, p75 13, p90 28, p95 40. Size p50 21 KB, p75 47 KB, p90 100 KB, p95 176 KB. 167 plans (13%) were at or past 30 decisions or 100 KB. A 40 KB line would have covered 382 (29%).
* Four-call creation: work item `EI-28712348345595435`.
* Tests: `packages/operator-core/lib/agent-tools/plans/new-parse-admission.test.ts`, `plan-size-advisory.test.ts` and `add-decision.test.ts` in the same directory.
