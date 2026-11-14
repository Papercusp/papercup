/**
 * The plan authoring checklist returned with a plans:new refusal (EI-28712348345595435).
 *
 * WHY IT RIDES THE REFUSAL. A refused plans:new is the one moment the author is
 * about to re-send the whole plan body, so advice delivered there can still change
 * the plan. The tool prompt has no room for it (plans:new sits at its prompt-weight
 * budget), and advice that lives only in a doc is read after the plan has stalled.
 *
 * WHAT IT IS. Twelve working rules from the 2026-11-13 analysis of why plans stall
 * (two release plans that reached their last items and stopped there). They are
 * ADVICE: plans:new enforces none of them, and nothing here may be turned into a
 * gate without a separate decision. The long form, with the evidence behind each
 * rule, is the agent-insights doc named by `PLAN_AUTHORING_CHECKLIST_DOC`.
 *
 * Rule 8 is DERIVED from `PLAN_SIZE_BUDGET`, so the size the checklist quotes can
 * never drift from the size plans:add-decision advises on.
 */

import { PLAN_SIZE_BUDGET } from './plan-size-advisory';

export const PLAN_AUTHORING_CHECKLIST_DOC =
  '/internal/docs/agent-insights/plan-authoring-checklist-plans-that-do-not-stall';

export const PLAN_AUTHORING_CHECKLIST: readonly string[] = [
  'For each requirement, name the cheapest place it can be proven and prove it there. A requirement goes on the live plane only when no test can show it.',
  "The first item proves the last item's route: the right project, an identity allowed to act there, a worker that can take the task, and the running build read back.",
  'A live pass condition names the running build that must contain the change and how that is read. Passing tests in the working tree is not that.',
  "No final item whose pass depends on systems outside the feature. If a drill needs a gate, a rig or a fork, say which failures count as the feature's.",
  'At most seven requirements per release. More means two releases.',
  'Proof must be re-runnable in minutes. If it is not, building the fast version is item one.',
  'A failed acceptance run creates a fix item, never a new prerequisite.',
  `Decisions are rulings. Step-by-step notes go on work items. A plan past ${PLAN_SIZE_BUDGET.decisions} decisions or ${Math.round(PLAN_SIZE_BUDGET.bytes / 1000)} KB gets split or replaced.`,
  'The last item never bundles summary, grading, audit, deploy and ship.',
  'Every plan names its driver, a backup, and what happens when the driver is silent for 24 hours.',
  'Nobody waits on an absent author: the driver repairs the test after a set time and a non-implementer reviews it afterwards.',
  'Before proposing a plan, list the open plans in the same area and extend one if it fits.',
];

export interface PlanAuthoringChecklist {
  note: string;
  lines: readonly string[];
  doc: string;
}

/** The checklist as it rides a refusal: the rules, what they are, and where the long form lives. */
export function planAuthoringChecklist(): PlanAuthoringChecklist {
  return {
    note: 'Advice for the retry, not a gate: plans:new enforces none of these. They are the rules that keep a plan from stalling at its last items.',
    lines: PLAN_AUTHORING_CHECKLIST,
    doc: PLAN_AUTHORING_CHECKLIST_DOC,
  };
}
