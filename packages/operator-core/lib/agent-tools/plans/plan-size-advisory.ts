/**
 * Plan size advice for append-style plan writes (WI-6554700010048088).
 *
 * Decisions get used as a work log: an agent records each step, test result and
 * status note as a new `D-NNN`, and the plan grows until the rulings other lanes
 * must follow are buried. Measured 2026-11-13 on this workspace: one plan held
 * 354 decisions in 965 KB, another 85 decisions in 197 KB.
 *
 * ADVICE, NEVER A REFUSAL. The write this rides on has already landed by the time
 * the advisory is built, and no caller may turn it into a gate: agents must stay
 * able to add to plans (owner feedback 2026-10-26). The advisory only names the
 * better home for a step-by-step note — the work item — on the response to the
 * exact write that needed the nudge.
 *
 * The budget is the measured tail, not a round number. Over the 1,306 unarchived
 * plans in this workspace that carry at least one decision (2026-11-13):
 * decisions p50 7 · p75 13 · p90 28 · p95 40; size p50 21 KB · p75 47 KB ·
 * p90 100 KB · p95 176 KB. A plan past EITHER line below is in roughly the
 * largest tenth (167 of 1,306 = 13%). A 40 KB line would have fired on 382 of
 * them (29%) — an advisory that fires on a third of writes is read as noise, and
 * then it protects nothing on the plans that are genuinely out of hand.
 *
 * Pure and dependency-free on purpose, so another append-style plan write can
 * reuse it without importing a tool module (see the note in `add-decision.ts`
 * on why lib-tier callers must not import that file).
 */

/** A plan is over budget when it exceeds EITHER line, measured after the write. */
export const PLAN_SIZE_BUDGET = { decisions: 30, bytes: 100_000 } as const;

/** Below this many same-day decisions the "dated today" sentence stays out of the message. */
const SAME_DAY_MENTION_FLOOR = 5;

export interface PlanSizeMeasure {
  /** Decisions in the plan after the write. */
  decisions: number;
  /** UTF-8 size of the plan body after the write. */
  bytes: number;
  /** Decisions dated `today` after the write — the work-log tell. */
  decisionsToday: number;
}

export interface PlanSizeAdvisory {
  code: 'plan_over_size_budget';
  decisions: number;
  bytes: number;
  decisionsToday: number;
  budget: { decisions: number; bytes: number };
  /** Which line(s) the plan is past. Never empty. */
  over: Array<'decisions' | 'bytes'>;
  message: string;
  /** Where a step-by-step note goes instead of a new decision. */
  workLogInstead: string[];
}

/**
 * Measure a plan body. `existing` is the decisions parsed from the body BEFORE the
 * write; `appended` is how many decisions the write adds (0 for a no-op retry), each
 * stamped `today`. Counting from the parse avoids re-parsing the written body.
 */
export function measurePlanSize(
  body: string,
  existing: ReadonlyArray<{ date: string | null }>,
  today: string,
  appended = 0,
): PlanSizeMeasure {
  return {
    decisions: existing.length + appended,
    bytes: Buffer.byteLength(body, 'utf8'),
    decisionsToday: existing.filter((d) => d.date === today).length + appended,
  };
}

/** Null when the plan is within budget (or was not measured), so the common case keeps its exact result shape. */
export function planSizeAdvisory(measure: PlanSizeMeasure | null | undefined): PlanSizeAdvisory | null {
  if (!measure) return null;
  const over: Array<'decisions' | 'bytes'> = [];
  if (measure.decisions > PLAN_SIZE_BUDGET.decisions) over.push('decisions');
  if (measure.bytes > PLAN_SIZE_BUDGET.bytes) over.push('bytes');
  if (over.length === 0) return null;
  const kb = Math.round(measure.bytes / 1000);
  const budgetKb = Math.round(PLAN_SIZE_BUDGET.bytes / 1000);
  const sameDay =
    measure.decisionsToday >= SAME_DAY_MENTION_FLOOR ? ` ${measure.decisionsToday} of them are dated today.` : '';
  return {
    code: 'plan_over_size_budget',
    decisions: measure.decisions,
    bytes: measure.bytes,
    decisionsToday: measure.decisionsToday,
    budget: { ...PLAN_SIZE_BUDGET },
    over,
    message:
      `Recorded. This plan now holds ${measure.decisions} decisions in ${kb} KB, past the size budget of ` +
      `${PLAN_SIZE_BUDGET.decisions} decisions / ${budgetKb} KB.${sameDay} Keep decisions for rulings other lanes ` +
      'must follow. A progress note, a test result or a step-by-step record belongs on the work item instead: ' +
      'work_items:checkpoint { id, checkpoint } for the current state, work_items:comment { id, body } for a running log.',
    workLogInstead: ['work_items:checkpoint { id, checkpoint }', 'work_items:comment { id, body }'],
  };
}
