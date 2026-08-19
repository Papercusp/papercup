/**
 * Get a single goal by id. Returns lineage (children + descendant tasks)
 * when detail='full'.
 *
 * Uses `schemaOf(generated.goalsInHarnessShared).select` so the response
 * row shape is the same Zod schema you'd use in a form or a CRUD admin
 * page — no hand-typed `Record<string, unknown>`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';
import { readGoalReadiness } from './goal-deps';
import { readGoalLastPause, readGoalPause } from './pause-record';

const goals = generated.goalsInHarnessShared;
const GoalSelect = schemaOf(goals).select;
type GoalRow = z.infer<typeof GoalSelect>;

export default defineTool({
  name: 'goals:get',
  capability: 'goals:read',
  guidance: {
    when: 'User names a specific goal and wants the rationale / acceptance criteria.',
    notWhen: 'For a list of goals, use `goals:list` first.',
    chaining: 'Follow `goals:list` to find the id.',
  },
  args: z.object({
    id: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select()
      .from(goals)
      .where(eq(goals.id, args.id))
      .limit(1)) as GoalRow[];
    if (!rows.length) {
      return { data: null, degraded: true, degradedReasons: [`goal ${args.id} not found`] };
    }
    const goal = rows[0];
    // Readiness (goal-dag-shared-substrate-2026-08-18 P-003, D-002/D-003):
    // derived on read from the shared dependency substrate. `actionable` = every
    // blocked-by edge satisfied (doable right now); `premiseInvalidated` = a
    // KILLED goal blocker — this goal needs review, not silent unblocking. A
    // READ, never a dispatch signal.
    const readiness = await readGoalReadiness(ctx.tx, goal.workspaceId, goal.id);
    // The DELIBERATE-PAUSE record (goal-live-holder-guarantee-2026-08-18 P-005,
    // D-009), parsed out of `metadata` rather than left for the caller to find.
    //
    // Surfaced at BOTH detail levels, and `status` joins the summary with it.
    // The precedent is unambiguous: `routines:set` wrote this same record for
    // months while `routines:list` selected `active` and not `metadata`, so the
    // responder it was written FOR still saw a bare stopped flag and filed a
    // deliberate hold as a suspected stall — twice, then a third time
    // (EI-19336000265007219). A durable record nobody can read is not a fix. A
    // summary that cannot say "paused, by whom, why" reproduces it exactly.
    const metadata = (goal.metadata ?? null) as Record<string, unknown> | null;
    const pause = readGoalPause(metadata);
    if (args.detail === 'summary') {
      return {
        data: {
          id: goal.id,
          title: goal.title,
          status: goal.status,
          pause,
          actionable: readiness.actionable,
          premiseInvalidated: readiness.premiseInvalidated,
        },
      };
    }
    const children = (await txDb
      .select({ id: goals.id, title: goals.title })
      .from(goals)
      .where(eq(goals.parentId, args.id))) as Array<Pick<GoalRow, 'id' | 'title'>>;
    return {
      data: {
        ...goal,
        children,
        pause,
        // The archived record of the last pause that has since been resumed —
        // "was this ever held, and by whom" survives the resume.
        lastPause: readGoalLastPause(metadata),
        actionable: readiness.actionable,
        premiseInvalidated: readiness.premiseInvalidated,
        blockedBy: readiness.blockers,
      },
    };
  },
});
