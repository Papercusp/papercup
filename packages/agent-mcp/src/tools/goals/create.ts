/**
 * goals:create — open a durable GOAL record.
 *
 * The write half of a table that had a schema, a GIN full-text index, a
 * self-referencing lineage edge and two read tools, but no way to put a row in
 * it: `harness_shared.goals` held ZERO rows because nothing had ever written
 * one (goal-mode-2026-08-07 P-009).
 *
 * WHY A GOAL IS NOT A POT. Under D-009 a v1 goal lives as pots inside the
 * existing workspace, which tempts the shortcut "the pot IS the goal record".
 * It is not, and the cardinality is what gives it away: one goal spawns MANY
 * projects, so N pots share one goal and no single pot can carry the goal's
 * kill criterion, its spend ceiling, or its lineage. GOAL mode's contract
 * mandates both a kill criterion and a spend ceiling at creation time — this
 * row is where they live, which is exactly what `budget_cents` and `parent_id`
 * were shaped for.
 *
 * Reads already exist (`goals:list`, `goals:get`, the
 * `papercusp://workspace/goals` resource, and search:query's `goals` kind).
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { SU_WRITE_ROLES } from '../../role-config';

/** A readable, collision-resistant id: `ship-paid-app-3f9a1c`. */
export function goalId(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${stem || 'goal'}-${randomBytes(3).toString('hex')}`;
}

export const GOAL_STATUSES = ['active', 'achieved', 'killed', 'paused'] as const;

export default defineTool({
  name: 'goals:create',
  description:
    'Open a durable GOAL record (harness_shared.goals) — the weeks-long outcome a GOAL-mode agent owns, above the pot/plan/work-item stack. ' +
    '{ title, body?, killCriterion?, budgetCents?, parentId?, status? }. Returns the allocated id. ' +
    'A goal is NOT a pot: one goal spawns many projects, so the kill criterion and spend ceiling live HERE, not on any one pot.',
  capability: 'goals:write',
  guidance: {
    when:
      'Entering GOAL mode on a new outcome, or splitting an owned goal into a sub-goal (pass parentId). Record it BEFORE creating the pots/plans that pursue it, so the kill criterion and spend ceiling exist before the spending does.',
    notWhen:
      'For a concrete unit of work use work_items:create; for a project use pot:create; for the plan of attack use plans:new. A goal is the INTENT those serve — if it has an obvious done-when-this-PR-merges, it is not a goal.',
    chaining: 'goals:create → pot:create / plans:new per project → goals:update to record actuals, or status:"killed" when the kill criterion trips.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: z.object({
    title: z.string().min(1).max(500).describe('the outcome, stated so its achievement is checkable'),
    body: z.string().max(20000).optional().describe('the full statement: what winning looks like, scope, constraints'),
    killCriterion: z
      .string()
      .max(2000)
      .optional()
      .describe('the written condition under which this goal is abandoned — GOAL mode requires one at creation time'),
    budgetCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('declared spend ceiling in cents — the number actuals are reported against'),
    parentId: z.string().min(1).optional().describe('parent goal id, for a sub-goal'),
    status: z.enum(GOAL_STATUSES).default('active'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  async handler(args, ctx) {
    // The table declares workspace_id NOT NULL with a CHECK (workspace_id <> ''),
    // so — unlike harness_text_artifacts, whose blank-stamp fallback minted the
    // legacy rows EI-280 had to repair — there is no safe empty default here.
    // Resolve GUC-first, then ctx, and REFUSE rather than write a row the
    // constraint would reject with a less legible error.
    const [gucRow] = await ctx.tx<Array<{ ws: string | null }>>`
      SELECT NULLIF(current_setting('app.workspace_id', true), '') AS ws
    `;
    const workspaceId =
      gucRow?.ws || (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : null);
    if (!workspaceId) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [
          'no concrete workspace in scope (neither the app.workspace_id GUC nor ctx.workspaceId resolved) — a goal cannot be filed workspace-less',
        ],
      };
    }
    const installSlug = ctx.harnessSlug;
    if (!installSlug) {
      return {
        data: null,
        degraded: true,
        degradedReasons: ['no harness in scope — goals are filed against an install_slug'],
      };
    }

    const id = goalId(args.title);
    const metadata = {
      ...(args.metadata ?? {}),
      ...(args.killCriterion ? { killCriterion: args.killCriterion } : {}),
    };
    await ctx.tx`
      INSERT INTO harness_shared.goals
        (id, install_slug, workspace_id, title, body, parent_id, budget_cents, status, metadata)
      VALUES
        (${id}, ${installSlug}, ${workspaceId}, ${args.title}, ${args.body ?? null},
         ${args.parentId ?? null}, ${args.budgetCents ?? null}, ${args.status},
         ${Object.keys(metadata).length ? JSON.stringify(metadata) : null}::jsonb)
    `;
    return {
      data: {
        id,
        title: args.title,
        status: args.status,
        parent_id: args.parentId ?? null,
        budget_cents: args.budgetCents ?? null,
        kill_criterion: args.killCriterion ?? null,
        workspace_id: workspaceId,
        install_slug: installSlug,
      },
    };
  },
});
