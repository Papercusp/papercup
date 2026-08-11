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

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { killCriterionProblem } from '@papercusp/operator-core/lib/goals/kill-criterion';
import { SU_WRITE_ROLES } from '../../role-config';
import { GOAL_STATUSES, TripwireSchema, goalId, insertGoalRow } from './_core';

// The id minter, the status vocabulary, the tripwire schema and the row write
// live in `./_core` so `goals:start` (operator-core — it also SPAWNS the
// GOAL-mode agent, which cannot be done from this package) shares one
// definition with this tool instead of re-typing the column list. Re-exported
// here because these were this module's public surface first, and callers
// (goals:update, goals:propose, the HUD board) already import them from it.
export { GOAL_STATUSES, TripwireSchema, goalId };
export type { Tripwire, GoalStatus } from './_core';

export default defineTool({
  name: 'goals:create',
  description:
    'Open a durable GOAL record (harness_shared.goals) — the weeks-long outcome a GOAL-mode agent owns, above the pot/plan/work-item stack. ' +
    '{ title, body?, killCriterion?, tripwires?, budgetCents?, parentId?, status? }. Returns the allocated id. ' +
    'A goal is NOT a pot: one goal spawns many projects, so the kill criterion and spend ceiling live HERE, not on any one pot. ' +
    'If the caller already has an active GOAL-mode row, stamps its subject with this id so later creations carry provenance. ' +
    'This tool does NOT enter GOAL mode; use goals:start for a new GOAL-mode owner or mode:set with mode:"goal" and subject:"<id>" for an existing session.',
  capability: 'goals:write',
  guidance: {
    when:
      'Recording a goal that an already-running GOAL-mode session owns, or splitting an owned goal into a sub-goal (pass parentId). Record it BEFORE creating the pots/plans that pursue it, so the kill criterion and spend ceiling exist before the spending does.',
    notWhen:
      'Do not use this as the mode-entry path for a new GOAL-mode agent — use goals:start, which creates the goal, enters GOAL mode, and spawns atomically. For a concrete unit of work use work_items:create; for a project use pot:create; for the plan of attack use plans:new. A goal is the INTENT those serve — if it has an obvious done-when-this-PR-merges, it is not a goal.',
    chaining: 'goals:start for a new GOAL-mode owner, or goals:create → mode:set { mode:"goal", subject:"<id>" } for an existing session → pot:create / plans:new per project → goals:update to record actuals, or status:"killed" when the kill criterion trips.',
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

    // EI-20049757392342975: a criterion that states no abandonment condition is
    // refused HERE too, not only at `goals:propose` and `goals:update`.
    //
    // Why this door was the gap that mattered. `goals:propose` validates and
    // then WRITES NOTHING — its own description says the confirm card is
    // "fully-editable" and "one button calls goals:create". So the owner could
    // edit the criterion down to a stub in that card and this door would land
    // it, bypassing the check propose had just applied. `goals:update`'s
    // comment already assumed otherwise in as many words ("a criterion the
    // create path would have rejected"), which is how the gap stayed invisible:
    // the doc described the system as if this line existed.
    //
    // A BLANK/ABSENT criterion still passes, deliberately — a goal may be
    // created with none at all (WI-37604, owner-directed 2026-08-09). That
    // overrule is about PRESENCE; this rule is about quality GIVEN presence,
    // and kill-criterion.ts's header separates the two explicitly. Same
    // `if (trimmed)` composition `goals:update` already ships.
    const criterionArg = args.killCriterion?.trim();
    if (criterionArg) {
      const problem = killCriterionProblem(criterionArg);
      if (problem) return { data: null, degraded: true, degradedReasons: [problem] };
    }

    const id = goalId(args.title);
    await insertGoalRow(ctx.tx, {
      id,
      installSlug,
      workspaceId,
      title: args.title,
      body: args.body ?? null,
      parentId: args.parentId ?? null,
      budgetCents: args.budgetCents ?? null,
      status: args.status,
      killCriterion: args.killCriterion ?? null,
      tripwires: args.tripwires ?? null,
      metadata: args.metadata ?? null,
    });

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

    // EI-20185819124341317: `mode_subject_stamped:false` is intentionally not
    // an error — humans and scripts may create a goal outside GOAL mode — but a
    // caller that supplied GOAL-shaped controls is very likely about to proceed
    // as though the mode transition happened. Make that mismatch impossible to
    // miss while preserving the successful goal write and the compatibility
    // boolean above. `budgetCents: 0` is still an explicit GOAL control, while
    // an empty tripwire array carries no control and should stay quiet.
    const goalIntentSupplied = Boolean(
      criterionArg ||
        args.budgetCents !== undefined ||
        (args.tripwires?.length ?? 0) > 0,
    );
    const modeSubjectAdvisory = !modeSubjectStamped && goalIntentSupplied
      ? {
          code: 'goal_mode_not_active',
          severity: 'warning',
          message:
            'The goal was created, but this session is not in GOAL mode, so subsequent projects will not be attributed to it automatically.',
          next: [
            {
              tool: 'goals:start',
              detail: 'For a new GOAL-mode owner, use goals:start so goal creation, mode entry, and spawn are atomic.',
            },
            {
              tool: 'mode:set',
              args: { mode: 'goal', subject: id, reason: 'Attribute this existing session to the goal just created.' },
              detail: 'For this existing session, enter GOAL mode with the created goal as its subject before creating projects.',
            },
          ],
        }
      : undefined;

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
        ...(modeSubjectAdvisory ? { mode_subject_advisory: modeSubjectAdvisory } : {}),
      },
    };
  },
});
