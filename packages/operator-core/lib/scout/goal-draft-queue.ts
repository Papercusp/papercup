/**
 * goal-draft-queue.ts — WI-39879 (plan blender-goal-amendment-rail-2026-08-19 P-001).
 *
 * THE QUESTION THIS ANSWERS: "what would the Blender propose if it were allowed to
 * create a goal?" Until now that was unanswerable. `scout_routed_ideas` carries 1,682
 * rows and ZERO at `rail='goal'` (measured 2026-08-19, Jun 11 → Aug 18), because
 * intake never accepts the hint — so every argument about whether the Blender should
 * be allowed near goals was being made with no evidence at all.
 *
 * THE MECHANISM, and why it is this small: the evidence was almost already there.
 * `scout_cycle_stage_artifacts.proposals` has persisted full proposal content all
 * along; the only thing missing was the field saying which of those proposals were
 * goal-scale, which `parseProposal` recorded and then dropped one hop before the
 * Proposal was built (WI-39721 tallied it, but the tally died at the `recombine` port
 * boundary — the port is typed `=> Promise<Proposal[]>`, so the cycle never saw it and
 * the only trace was a console.warn). Carrying `droppedRouteHint` onto the Proposal
 * turned an existing artifact into the draft queue. This module is the READ side.
 *
 * ⚠ THIS MODULE WRITES NOTHING, BY CONSTRUCTION — that is its entire safety argument,
 * and it is enforced, not promised:
 *   • it issues exactly one SELECT and holds no write port;
 *   • it never imports a goals writer, so it CANNOT reach `goals:create`/`goals:update`;
 *   • the drafted rails come from {@link draftGoalRails}, a PURE function;
 *   • routing is untouched — a drafted proposal still took DEFAULT_ROUTING_RAIL when
 *     its cycle ran, and nothing here re-routes it.
 * `goal-draft-queue.test.ts` asserts each of those, including a fake-pg statement
 * recorder that fails on any non-SELECT. Admitting 'goal' at intake remains the
 * owner-reserved decision (D-006) and is NOT what this module does.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { GOAL_SCALE_MARKERS, draftGoalRails, makeGoalScaleOverride, proposalTitle } from './router';
import type { Proposal } from './types';

/** The rail whose starvation this queue exists to make readable. */
export const DEFAULT_DRAFT_RAIL = 'goal';

/**
 * HOW a proposal came to be goal-scale. Both are recorded, because they answer
 * different questions and only one of them is currently live.
 *
 * • 'asked'    — the MODEL explicitly asked for the goal rail and intake coerced the
 *                hint away (`droppedRouteHint`). Measured 2026-08-19: this has NEVER
 *                happened in the 30 retained cycles — every proposal carried an
 *                accepted hint — so a queue keyed on this alone reads empty forever.
 * • 'override' — the proposal was 'plan'-hinted AND matched the goal-scale vocabulary,
 *                so {@link makeGoalScaleOverride} WOULD bump it to the goal rail. This
 *                is the path that is actually live in production (cycle-deps.ts wires
 *                exactly this override, and BLENDER_GOAL_RAIL is default-ON).
 */
export type GoalDraftPath = 'asked' | 'override';

/**
 * One thing the Blender WOULD have proposed, had the rail been open to it.
 *
 * `killCriterion` and `budgetCents` are DRAFTED here at read time by the same pure
 * function the live goal rail would have used — they were never stored, because the
 * proposal never reached the rail. That is deliberate: it keeps the queue a pure
 * projection of what was actually recorded, with no second copy to drift.
 */
export interface GoalDraft {
  /** The cycle that produced it — joins to scout_ticks / scout_routed_ideas. */
  cycleId: string;
  /** When that cycle's artifacts landed. */
  createdAt: Date;
  /** The rail the model asked for and did not get (verbatim, as the model wrote it). */
  askedRail: string;
  /** The proposal's human title — first non-empty line of the framing, capped. */
  title: string;
  /** The full proposal as persisted, minus nothing. */
  proposal: Proposal;
  /** What the goal rail WOULD have set as the abandonment condition. */
  killCriterion: string;
  /** What the goal rail WOULD have set as the spend ceiling, in cents. */
  budgetCents: number;
}

/** One persisted stage-artifact row, narrowed to what this queue reads. */
export interface StageArtifactRow {
  cycle_id: string;
  created_at: Date | string;
  proposals: unknown;
}

const isProposal = (v: unknown): v is Proposal =>
  v != null && typeof v === 'object' && typeof (v as { framing?: unknown }).framing === 'string';

/**
 * PURE core: persisted stage-artifact rows → the drafts among them. No IO, no clock,
 * no writes — so a caller can assert the whole selection with fixtures and never touch
 * Postgres (scout invariant #5: assert behaviour without real writes).
 *
 * A row whose `proposals` is null, not an array, or full of malformed entries yields
 * nothing rather than throwing: the artifact store is BEST-EFFORT by contract
 * (stage-artifacts.ts), so a partial row must degrade to less evidence, never to an
 * exception on the read path.
 */
export function selectGoalDrafts(
  rows: readonly StageArtifactRow[],
  opts: { rail?: string; budgetCentsCap?: number } = {},
): GoalDraft[] {
  const rail = opts.rail ?? DEFAULT_DRAFT_RAIL;
  const drafts: GoalDraft[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.proposals)) continue;
    for (const raw of row.proposals) {
      if (!isProposal(raw)) continue;
      if (raw.droppedRouteHint !== rail) continue;
      const { killCriterion, budgetCents } = draftGoalRails(raw, {
        ...(opts.budgetCentsCap == null ? {} : { budgetCentsCap: opts.budgetCentsCap }),
      });
      drafts.push({
        cycleId: row.cycle_id,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        askedRail: raw.droppedRouteHint,
        title: proposalTitle(raw),
        proposal: raw,
        killCriterion,
        budgetCents,
      });
    }
  }
  return drafts;
}

/**
 * Read the draft queue for a workspace, newest cycle first.
 *
 * The ONLY statement this module issues, and it is a SELECT. `limit` bounds CYCLES
 * read, not drafts returned — a cycle can contribute several drafts, and truncating
 * mid-cycle would silently under-report a burst, which is the shape of error this
 * queue exists to prevent.
 */
export async function readGoalDraftQueue(opts: {
  workspaceId?: string;
  rail?: string;
  budgetCentsCap?: number;
  /** Max CYCLES scanned (default: the artifact store's full retention). */
  limit?: number;
} = {}): Promise<GoalDraft[]> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT cycle_id, created_at, proposals
      FROM harness_shared.scout_cycle_stage_artifacts
     WHERE workspace_id = ${ws}
       AND proposals IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ${opts.limit ?? 30}`) as unknown as StageArtifactRow[];
  return selectGoalDrafts(rows, {
    ...(opts.rail == null ? {} : { rail: opts.rail }),
    ...(opts.budgetCentsCap == null ? {} : { budgetCentsCap: opts.budgetCentsCap }),
  });
}
