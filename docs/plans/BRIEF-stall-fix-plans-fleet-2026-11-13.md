# Brief: carry the thirteen stall-fix plans to shipped

Written 2026-11-13 by su-a3d219cb for the fleet Avi launches on these plans.
Record: WI-6554700010048033. Harness: papercusp.

Background reading, in this order:

- `rpt_5f9faea4-4389-4070-82dd-160b59f65423` — why plans stall, and which fixes to carry out (`reports:get`).
- `rpt_4350b971-2743-48d0-88e7-289ab5bcf5c7` — the Slack/Asana delivery stall seen from the inside.

> Every number and name below was read on 2026-11-13 between 22:30 and 23:00 UTC.
> It is a snapshot of a live system. Re-read item states (`plans:items`) and the
> live roster (`coord:presence`) before you act on any of it.

## Mission

Thirteen open plans each fix part of one problem: work here gets built in days
and then fails to finish. Together they hold 125 items. 25 are done, and ten of
the plans have closed nothing.

Your job is to bring every one of the thirteen to an end state. Avi's words, from
his dialog answer on 2026-11-13: "I will launch a fleet to carry all these plans
to shipped status."

These plans are the fixes for stalling. Until they ship, every other plan keeps
paying for the problems they remove, including the plans in this list.

## Done means

- Each of the thirteen is shipped (`plans:set-plan-status { status: 'shipped' }`
  accepted), or superseded by a named plan that absorbed its open items, or
  dropped with a recorded reason.
- No new plan was created to get there.
- For each shipped plan, the change is live on the build agents run, read back
  from that build and not inferred from a passing test.

## The plans

"On it now" is who named the plan in the live roster when I looked. It does not
show who worked a plan earlier.

| # | Plan slug | Status | Done / items | First open item | On it now |
| --- | --- | --- | --- | --- | --- |
| 1 | deterministic-mission-continuity-2026-11-05 | ready | 0 / 9 | P-001 map the assignment and custody APIs | nobody |
| 2 | managed-carry-lifecycle-enforcement-2026-09-13 | ready | 8 / 9 | P-006 audit, vetting, independent grading | nobody |
| 3 | agent-paperwork-and-restart-tax-reduction-2026-10-15 | ready | 14 / 23 | P-015 re-run the paperwork measurement | fleet workflow-efficiency-shipping-2026-11-07 (leader su-81a8580f, member su-1a1d1b35) |
| 4 | lifecycle-driven-git-sync-2026-11-06 | ready | 3 / 13 | P-004 broaden pilot capture | su-07e4aca6, fleet main-green-improvements-sol61-1102 |
| 5 | source-scoped-reproduction-freshness-2026-11-07 | draft | 0 / 3 | P-001 source-only receipt verification | nobody |
| 6 | workflow-step-measurements-2026-11-09 | ready | 0 / 3 | P-001 extend usage and cost measurement | su-1ed1aa1a |
| 7 | metadata-worker-custody-source-artifact-2026-11-10 | ready | 0 / 2 | P-001 source-to-private-Git-artifact adapter | nobody |
| 8 | compaction-recovery-fact-delivery-2026-11-09 | draft | 0 / 4 | P-001 selector and coverage contract | nobody |
| 9 | stuck-work-detection-and-honest-waits-2026-11-13 | draft | 0 / 10 | P-001 clear the live incident by hand | su-5d156330 (live) |
| 10 | grounded-evidence-and-continuity-2026-11-05 | ready | 0 / 8 | P-001 materialize the fixtures and oracles | su-dabbef36 |
| 11 | post-verdict-proof-warming-and-git-adoption-2026-11-05 | draft | 0 / 7 | P-001 census of existing behaviour | nobody |
| 12 | goal-mode-and-grading-consolidated-finish-2026-11-13 | draft | 0 / 22 | P-001 re-measure the shared blockers | nobody; its P-012 text names su-3dc05505 on WI-6554700010046078 |
| 13 | agent-shipping-workflow-effort-reduction-2026-11-07 | draft | 0 / 12 | P-001 inventory writers, consumers and gaps | su-a846e98c, fleet workflow-efficiency-shipping-2026-11-07 |

Most open items are waiting on an earlier item in the same plan, not on anything
outside it.

## Suggested order

This order comes from item lines and status text. I did not read every plan's
full requirement text. Correct it once you have.

1. **Mission continuity (1) first.** Both reports found the same cause on their
   own: a driver stops and nothing puts the work back. Shipping-workflow P-007 is
   recorded as absorbed into this plan and restart-tax P-020 integrates its
   output, so two other plans cannot finish before it. Its status text has
   carried a bar-readiness block since Nov 10 (`bar_snapshot_rubric_unresolved`).
   Resolve that read first and do not re-seed the rubric on that evidence.
2. **Managed carry (2) alongside it.** One item is left, the final acceptance.
   It is the nearest to shipped, and finishing it shows how long the shipping
   steps really take.
3. **Restart-tax (3), items P-016 and P-021.** P-016 covers the unchanged-proof
   and changed-scope cases. P-021 covers cheap-before-expensive checks and names
   P2P as its test case. A fleet is already on this plan. Work with its leader.
4. **Lifecycle git-sync (4).** It is what makes tested code reach the running
   system. An agent from another fleet is on it. Work with that agent.
5. **The small plans (5, 6, 7, 8).** Two to four items each. I saw no
   dependency on the plans above.
6. **Stuck-work (9), grounded evidence (10), proof warming (11).**
7. **Grading consolidated (12).** It has 22 items and ends in one item that
   bundles audit, grading and shipping. Split that item before you start (rule
   4 below). Its status text says it is a draft awaiting Avi's approval.
8. **Shipping-workflow (13) last.** Four of its twelve items are recorded as
   absorbed into other plans. When those plans ship, decide whether what is left
   is still a plan or folds into restart-tax.

## How plans here stall, and what to do instead

Both reports found the same shapes in P2P and in the Slack/Asana workflow. Several
of the thirteen already show them.

1. **Prove each requirement in the cheapest place that can show it.** Use
   staging (`:3170`) or an isolated current build for everything except the
   final shipment check.
2. **Prove the route of a live step before you build toward it.** Run it once
   with a trivial payload: the right project, an identity allowed to act there,
   a worker that can take the task, and the running build read back. The
   Slack/Asana drill learned at the very end that its driver could not act in
   the target project.
3. **A passing test does not put code in the running system.** For any live
   claim, read the build from the runtime (`dev:pipeline_position`,
   `/api/health`).
4. **Split a final item that bundles summary, grading, audit, deploy and ship.**
   Grading of finished work can then start while the rest continues.
5. **A failed acceptance run creates a fix item.** It does not add a new
   prerequisite item in front of acceptance.
6. **Decisions are rulings other agents must follow.** Step-by-step notes go on
   the work item (`work_items:checkpoint`, `work_items:comment`).
7. **Keep every plan driven.** One named driver per plan. If a driver goes
   silent, the leader re-places the plan the same day. Before you end a turn
   after a handoff, arm the wake that brings you back.
8. **Do not create a plan.** If you find a gap, add an item to the plan that
   owns the code.
9. **Do not let a pre-start review hold a plan in a repair loop.** Gaps that do
   not change what a bar means become a binding decision on the affected items,
   and the plan starts.

## Recorded owner feedback that bears on this

These come from shared memory, written by agents at the time. Re-verify with
`sessions:search` before treating either as a gate.

- Memory `f0f83de2-67a2-4ab9-ab70-1ae3e09a5fb0`, recorded as an owner quote on
  2026-10-26: "agents should be able to add stuff to plans and the issue isnt
  that i dont know that its not moving the issue is that its not moving. address
  the core issue." So do not gate other agents and do not page Avi that a plan
  is not moving. Make it move.
- Memory `57922948-4bdb-40cd-abed-0197d93be961`, recorded 2026-10-26 as a
  paraphrase: plan bar critiques must not hold a plan's start in an endless
  repair loop. Rule 9 above is that ruling.

## Do not collide with work already in flight

A claim conflict means coordinate with the holder. Never take a live peer's item.

- Fleet workflow-efficiency-shipping-2026-11-07, leader
  su-81a8580f-c0ae-42eb-b1b4-b1122697fca2, is on plans 3 and 13.
- Fleet main-green-improvements-sol61-1102, leader
  su-1b1c4d3e-d960-4de6-935e-95e776b84f58, has a member on plan 4.
- Fleet slack-asana-shipment-sol61-20261113, leader
  su-73cda48a-3c3c-48a8-90e1-af11adcf4918, runs the pipeline that plan 7 serves.
- su-5d156330 was live on plan 9, su-dabbef36 on plan 10, su-1ed1aa1a on plan 6.
- su-a3d219cb is changing the plan store in its own session. Do not duplicate
  these three, and check file locks before editing the same files:
  - one refusal that lists every plan authoring problem (EI-28712348345595435);
  - grading each requirement as its items finish (WI-6554700010048087);
  - size advice when a decision is added to a large plan (WI-6554700010048088).

## Two points that are Avi's, with the default if he has not said

- **Do the fleets above keep their plans?** Default: yes. They keep the plans
  they hold, and this fleet takes the seven with nobody on them (1, 2, 5, 7, 8,
  11, 12) and offers help on the rest.
- **Is launching this fleet the approval that plan 12 says it is waiting for?**
  Default: treat it as not yet approved. Do the read-only item P-001 and bring
  Avi the one approval question with the answer you recommend.

## What to report

Tell Avi when a plan reaches an end state, with the evidence. Do not send
progress updates and do not report that a plan is not moving.

How a plan ships, step by step: `docs:search` for
`agent-insights/acceptance-rubrics-on-every-plan-runbook`.
