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

/**
 * A TRIPWIRE turns the kill criterion from prose into a readout.
 *
 * A criterion written as a sentence ("kill this if we pass $500 or 30 days
 * without a shipped build") is a promise nobody re-checks; the same thing as
 * `{ metric, threshold, current }` renders as a bar the owner can act on at a
 * glance (goal-mode-2026-08-07 P-021). Deliberately OPTIONAL and unconstrained
 * as to metric name: a goal whose criterion is genuinely unquantifiable must
 * still be creatable, and the detail view renders the prose with no bars when
 * this is null. `current` is a snapshot the agent refreshes via goals:update —
 * it is NOT computed here, because most metrics (revenue, users, shipped
 * builds) live outside this database entirely.
 */
export const TripwireSchema = z.object({
  metric: z.string().min(1).max(60).describe('machine key, e.g. "days_elapsed" / "spend_usd"'),
  label: z.string().min(1).max(120).describe('how it reads to the owner, e.g. "Day 12 of 30"'),
  threshold: z.number().describe('the value at which the criterion trips'),
  current: z.number().optional().describe('latest observed value; omit until first measured'),
  unit: z.string().max(20).optional().describe('"usd" / "days" / "users" — display only'),
});
export type Tripwire = z.infer<typeof TripwireSchema>;

export default defineTool({
  name: 'goals:create',
  description:
    'Open a durable GOAL record (harness_shared.goals) — the weeks-long outcome a GOAL-mode agent owns, above the pot/plan/work-item stack. ' +
    '{ title, body?, killCriterion?, tripwires?, budgetCents?, parentId?, status? }. Returns the allocated id. ' +
    'A goal is NOT a pot: one goal spawns many projects, so the kill criterion and spend ceiling live HERE, not on any one pot. ' +
    'Side effect: stamps your GOAL mode with this id, so everything you create next carries its provenance without you passing it.',
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
    tripwires: z
      .array(TripwireSchema)
      .max(12)
      .optional()
      .describe(
        'structured form of the kill criterion — renders as live bars ("day 12 of 30", "$310 of $500") instead of prose nobody re-checks. Optional: a free-text criterion works with no tripwires.',
      ),
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
    // The kill criterion is a first-class COLUMN (migration 765), not a
    // metadata key. It used to be folded into `metadata` because the column did
    // not exist — but the whole GUI reads it (the detail view's "THIS GOAL ENDS
    // WHEN" headline, the rail's glance), and a jsonb key cannot be indexed,
    // constrained, or joined the way the read path needs.
    const metadata = { ...(args.metadata ?? {}) };
    await ctx.tx`
      INSERT INTO harness_shared.goals
        (id, install_slug, workspace_id, title, body, parent_id, budget_cents, status,
         kill_criterion, tripwires, metadata)
      VALUES
        (${id}, ${installSlug}, ${workspaceId}, ${args.title}, ${args.body ?? null},
         ${args.parentId ?? null}, ${args.budgetCents ?? null}, ${args.status},
         ${args.killCriterion ?? null},
         ${args.tripwires?.length ? JSON.stringify(args.tripwires) : null}::jsonb,
         ${Object.keys(metadata).length ? JSON.stringify(metadata) : null}::jsonb)
    `;

    // ── Stamp the caller's GOAL mode with the goal it is now running ─────
    // This side effect IS the provenance mechanism (P-016). Everything the
    // agent creates from here on — work-items, and later pots/plans — reads
    // `agent_modes.subject` from SESSION CONTEXT and stamps `goal_id` with it,
    // so "what belongs to this goal?" is answerable without asking any agent to
    // remember to pass an id. Agent self-report was the alternative and it does
    // not survive a compaction.
    //
    // `ctx.uiClientId` is the same value `resolveAgentIdentity` returns as
    // `ownerId` for every population that can run GOAL mode (su sessions and
    // signed fleet spawns). This package cannot import that resolver —
    // agent-mcp does not depend on operator-core — so the narrow UPDATE is
    // written here rather than routed through `setMode`.
    //
    // It DEGRADES, never fails: a goal creation must not be lost because the
    // caller happens not to be in GOAL mode (the common case for a human-driven
    // or scripted create), or because the transport carried no session id.
    let modeSubjectStamped = false;
    const callerOwnerId = ctx.uiClientId ?? null;
    if (callerOwnerId) {
      try {
        const stamped = await ctx.tx<Array<{ owner_id: string }>>`
          UPDATE harness_shared.agent_modes
             SET subject = ${id}
           WHERE workspace_id = ${workspaceId}
             AND owner_id = ${callerOwnerId}
             AND mode = 'goal'
          RETURNING owner_id
        `;
        modeSubjectStamped = stamped.length > 0;
      } catch {
        // Swallowed on purpose, and NOT silently: `mode_subject_stamped:false`
        // in the result is the signal, and it is the one the caller can act on
        // (enter GOAL mode, then re-assert). Failing the create here would
        // trade a missing decoration for a lost goal.
        modeSubjectStamped = false;
      }
    }

    return {
      data: {
        id,
        title: args.title,
        status: args.status,
        parent_id: args.parentId ?? null,
        budget_cents: args.budgetCents ?? null,
        kill_criterion: args.killCriterion ?? null,
        tripwires: args.tripwires ?? null,
        workspace_id: workspaceId,
        install_slug: installSlug,
        // Told plainly so the agent knows whether later creations will carry
        // provenance. false ⇒ you are not in GOAL mode on this session; enter
        // it (mode:set { mode:'goal' }) before creating the projects, or the
        // work will not be attributable to this goal.
        mode_subject_stamped: modeSubjectStamped,
      },
    };
  },
});
