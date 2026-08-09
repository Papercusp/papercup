/**
 * goals:attach-project / goals:detach-project / goals:projects — the write and
 * read halves of the goal ↔ project edge (goal-mode-2026-08-07 P-016).
 *
 * A goal is not a pot: it is pursued THROUGH projects, plural, and a project
 * can serve more than one goal. Until this edge existed the GUI could not
 * answer the first question anyone asks of a goal — "what is actually working
 * on this?" — because the only link was an agent's memory of which pot it had
 * made for which purpose, which does not survive the session that made it.
 *
 * The domain logic (roles, tombstones, the one-main-owner rule, and the
 * DISTINCT-over-projects spend rollup) lives in `@papercusp/db-org`'s
 * `goal-projects` module, not here: operator-core needs the same functions for
 * the sync-resolver queries and cannot import this package.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import {
  goalSpend,
  goalsForProject,
  linkProject,
  projectsForGoal,
  unlinkProject,
} from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { SU_WRITE_ROLES } from '../../role-config';

/**
 * Every one of these tools is workspace-scoped and a goal cannot be filed
 * workspace-less (the table's CHECK rejects a blank), so resolve GUC-first and
 * REFUSE rather than write against the wrong tenant.
 */
async function resolveWorkspace(ctx: {
  tx: unknown;
  workspaceId?: string;
}): Promise<string | null> {
  const tx = ctx.tx as Sql;
  const [gucRow] = await tx<Array<{ ws: string | null }>>`
    SELECT NULLIF(current_setting('app.workspace_id', true), '') AS ws
  `;
  return gucRow?.ws || (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : null);
}

/**
 * Built fresh per call rather than shared as a frozen constant: `as const`
 * would widen `degradedReasons` to a readonly tuple, which does not satisfy the
 * mutable `string[]` the tool result declares.
 */
const noWorkspace = (): { data: null; degraded: boolean; degradedReasons: string[] } => ({
  data: null,
  degraded: true,
  degradedReasons: [
    'no concrete workspace in scope (neither the app.workspace_id GUC nor ctx.workspaceId resolved)',
  ],
});

export const attachProject = defineTool({
  name: 'goals:attach-project',
  description:
    'Record that a project (harness) is being worked on IN SERVICE OF a goal. ' +
    '{ goalId, harnessSlug, role?: "owner"|"contributing", note? }. ' +
    'A project may serve several goals — attaching to a second one does NOT detach the first.',
  capability: 'goals:write',
  guidance: {
    when:
      'Right after creating (or adopting) a pot for a goal you own. This edge is what makes the goal\'s page show its projects, its spend, and its progress — an unattached project is invisible to the goal it serves.',
    notWhen:
      'For a unit of work inside a project use work_items:create; the goal stamp on those is automatic from your GOAL mode. This tool is for the PROJECT-level edge only.',
    chaining:
      'goals:create → pot:create → goals:attach-project { role:"owner" } → plans:new inside that pot.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: z.object({
    goalId: z.string().min(1),
    harnessSlug: z.string().min(1).describe('the project/harness slug'),
    role: z
      .enum(['owner', 'contributing'])
      .default('contributing')
      .describe(
        '"owner" = this goal is what the project primarily exists for (at most ONE goal per project — promoting demotes the incumbent to contributing). "contributing" = a real but secondary claim.',
      ),
    killCriterion: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'what would make this goal STOP pursuing this project (GOAL contract clause 4). Recorded on the link, not the harness, because a shared project can warrant a different answer per goal.',
      ),
    note: z.string().max(1000).optional().describe('why this project serves this goal'),
  }),
  async handler(args, ctx) {
    const workspaceId = await resolveWorkspace(ctx as never);
    if (!workspaceId) return noWorkspace();
    const link = await linkProject(ctx.tx as Sql, {
      workspaceId,
      goalId: args.goalId,
      harnessSlug: args.harnessSlug,
      role: args.role,
      by: ctx.uiClientId ?? null,
      note: args.note ?? null,
      killCriterion: args.killCriterion ?? null,
    });
    // How many goals this project now serves — the number behind the "shared
    // with N goals" badge, returned here so the caller learns about a shared
    // project at the moment it attaches rather than discovering it later as a
    // surprising spend figure.
    const siblings = await goalsForProject(ctx.tx as Sql, {
      workspaceId,
      harnessSlug: args.harnessSlug,
    });
    return {
      data: {
        ...link,
        servesGoals: siblings.map((s) => s.goalId),
        shared: siblings.length > 1,
      },
    };
  },
});

export const detachProject = defineTool({
  name: 'goals:detach-project',
  description:
    'Stop counting a project toward a goal: { goalId, harnessSlug }. Tombstones the link (keeps the history) rather than deleting it.',
  capability: 'goals:write',
  guidance: {
    when:
      'A project turned out not to serve this goal, or the goal moved on. Detaching removes it from the goal\'s page and from its spend rollup going forward.',
    notWhen:
      'Do NOT detach to record that a project FAILED — that is what killing it says. A detached project reads as "never really part of this", which loses the evidence that the goal tried something and stopped.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: z.object({ goalId: z.string().min(1), harnessSlug: z.string().min(1) }),
  async handler(args, ctx) {
    const workspaceId = await resolveWorkspace(ctx as never);
    if (!workspaceId) return noWorkspace();
    const removed = await unlinkProject(ctx.tx as Sql, {
      workspaceId,
      goalId: args.goalId,
      harnessSlug: args.harnessSlug,
      by: ctx.uiClientId ?? null,
    });
    return {
      data: { goalId: args.goalId, harnessSlug: args.harnessSlug, removed },
      ...(removed
        ? {}
        : {
            degraded: true,
            degradedReasons: [`no live link between ${args.goalId} and ${args.harnessSlug}`],
          }),
    };
  },
});

export const listGoalProjects = defineTool({
  name: 'goals:projects',
  description:
    'The projects a goal is pursued through, main owner first, with its spend rolled up: { goalId, sinceMs?, spend? }.',
  capability: 'goals:read',
  guidance: {
    when:
      'Reporting on a goal, or deciding where to put the next unit of effort. Read this BEFORE creating another project — the portfolio pass GOAL mode mandates is exactly this call plus goals:list.',
    chaining: 'goals:list → goals:projects → pot:status per project.',
  },
  // Principal-gated like its sibling reads (goals:list / goals:get) — the
  // write tools above are the ones that opt into role gating.
  args: z.object({
    goalId: z.string().min(1),
    spend: z.boolean().default(true).describe('include the spend rollup'),
    sinceMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('only count usage at or after this epoch-ms; omit for all time'),
  }),
  async handler(args, ctx) {
    const workspaceId = await resolveWorkspace(ctx as never);
    if (!workspaceId) return noWorkspace();
    const projects = await projectsForGoal(ctx.tx as Sql, { workspaceId, goalId: args.goalId });
    const shared = await Promise.all(
      projects.map(async (p) => ({
        ...p,
        servesGoals: (
          await goalsForProject(ctx.tx as Sql, { workspaceId, harnessSlug: p.harnessSlug })
        ).length,
      })),
    );
    if (!args.spend) return { data: { goalId: args.goalId, projects: shared } };
    const spend = await goalSpend(ctx.tx as Sql, {
      workspaceId,
      goalId: args.goalId,
      sinceMs: args.sinceMs,
    });
    return {
      data: {
        goalId: args.goalId,
        projects: shared,
        spend: {
          ...spend,
          // Named for what it measures. The goal agent's OWN turns are
          // subscription-billed and measure ~$0, so this is the cost of the
          // children a goal spawns — the number a ceiling should govern — not
          // a total cost of ownership.
          label: 'fleet spend',
          // Stated because it is counter-intuitive and summing is the natural
          // thing to do: a project serving two goals counts IN FULL on both.
          note:
            'A shared project counts in full against every goal it serves — goal spend figures DO NOT SUM into a portfolio total.',
        },
      },
    };
  },
});

export default attachProject;
