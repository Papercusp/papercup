/**
 * goals:update — move a goal's standing state.
 *
 * The other half of P-009's "wire the dead table". Creating a goal record is
 * only half a ratchet-guard: GOAL mode's contract says an agent that only ever
 * CREATES is a ratchet, so the goal must also be closable — `status: 'killed'`
 * when the kill criterion trips, `'achieved'` when it is met — and its ACTUAL
 * spend must be reportable against the ceiling declared at creation.
 *
 * Partial by construction: every field is optional and an omitted field is left
 * alone, so reporting actuals never silently clears a kill criterion.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { SU_WRITE_ROLES } from '../../role-config';
import { GOAL_STATUSES } from './create';

export default defineTool({
  name: 'goals:update',
  description:
    'Move a GOAL record\'s standing state (harness_shared.goals): { id, status?, title?, body?, killCriterion?, budgetCents?, spentCents?, parentId? }. ' +
    'Partial — an omitted field is left untouched. Use status:"killed" when the written kill criterion trips and "achieved" when the outcome is met; ' +
    'a goal that is only ever created and never closed is the ratchet GOAL mode exists to prevent.',
  capability: 'goals:write',
  guidance: {
    when:
      'Reporting actual spend against a goal\'s declared ceiling, revising its statement or kill criterion, or CLOSING it (achieved / killed). Under GOAL mode this is the standing-cadence write that keeps the owner report honest.',
    notWhen:
      'For per-project progress use the pot/plan/work-item beneath the goal — this row carries the goal-level state only. To read current state first, goals:get { id, detail:"full" }.',
    chaining: 'goals:get → goals:update. A goal closed here should have its projects wound down first (unpause the pot, release claims).',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: z.object({
    id: z.string().min(1),
    status: z.enum(GOAL_STATUSES).optional(),
    title: z.string().min(1).max(500).optional(),
    body: z.string().max(20000).optional(),
    killCriterion: z.string().max(2000).optional(),
    budgetCents: z.number().int().nonnegative().optional().describe('revise the declared ceiling'),
    spentCents: z.number().int().nonnegative().optional().describe('actuals to date, recorded in metadata alongside the ceiling'),
    parentId: z.string().min(1).nullable().optional().describe('re-parent, or null to detach'),
  }),
  async handler(args, ctx) {
    const existing = await ctx.tx<
      Array<{
        title: string;
        body: string | null;
        status: string;
        parent_id: string | null;
        budget_cents: string | null;
        metadata: Record<string, unknown> | null;
      }>
    >`
      SELECT title, body, status, parent_id, budget_cents, metadata
        FROM harness_shared.goals WHERE id = ${args.id} LIMIT 1
    `;
    if (!existing.length) {
      return { data: null, degraded: true, degradedReasons: [`goal ${args.id} not found`] };
    }
    const prev = existing[0]!;

    // Merge rather than replace: reporting spend must not clear the kill
    // criterion recorded at creation, and vice versa.
    const metadata: Record<string, unknown> = { ...(prev.metadata ?? {}) };
    if (args.killCriterion !== undefined) metadata.killCriterion = args.killCriterion;
    if (args.spentCents !== undefined) metadata.spentCents = args.spentCents;

    // Resolve every column in JS so "omitted" and "explicitly null" stay
    // distinguishable — a COALESCE in SQL cannot express detaching a parent,
    // and a conditional SQL fragment to work around that is worse.
    const next = {
      title: args.title ?? prev.title,
      body: args.body ?? prev.body,
      status: args.status ?? prev.status,
      budgetCents: args.budgetCents ?? (prev.budget_cents === null ? null : Number(prev.budget_cents)),
      parentId: args.parentId === undefined ? prev.parent_id : args.parentId,
      metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    };

    await ctx.tx`
      UPDATE harness_shared.goals
         SET title        = ${next.title},
             body         = ${next.body},
             status       = ${next.status},
             budget_cents = ${next.budgetCents},
             parent_id    = ${next.parentId},
             metadata     = ${next.metadata}::jsonb,
             updated_at   = now()
       WHERE id = ${args.id}
    `;

    const [row] = await ctx.tx<
      Array<{
        id: string;
        title: string;
        status: string;
        parent_id: string | null;
        budget_cents: string | null;
        metadata: Record<string, unknown> | null;
      }>
    >`
      SELECT id, title, status, parent_id, budget_cents, metadata
        FROM harness_shared.goals WHERE id = ${args.id} LIMIT 1
    `;
    return { data: row ?? null };
  },
});
