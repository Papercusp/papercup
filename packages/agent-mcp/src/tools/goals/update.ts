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
import { GOAL_STATUSES, TripwireSchema } from './create';
import { resolveGoalWorkspace } from './_workspace';
import { getGoalStopExecutor, isStoppingStatus, type GoalStopReport } from './stop-seam';

export default defineTool({
  name: 'goals:update',
  description:
    'Move a GOAL record\'s standing state (harness_shared.goals): { id, status?, title?, body?, killCriterion?, budgetCents?, spentCents?, parentId? }. ' +
    'Partial — an omitted field is left untouched. Use status:"killed" when the written kill criterion trips and "achieved" when the outcome is met; ' +
    'a goal that is only ever created and never closed is the ratchet GOAL mode exists to prevent. ' +
    'status:"paused"|"killed" EXECUTES a stop: it gates placement on the projects this goal OWNS and disarms the engine loops of sessions attributed to it, ' +
    'returning `stop` — read `stop.unattributedActiveLoops` and `degraded`, which report burn that is STILL RUNNING and could not be attributed to this goal.',
  capability: 'goals:write',
  guidance: {
    when:
      'Reporting actual spend against a goal\'s declared ceiling, revising its statement or kill criterion, or CLOSING it (achieved / killed). Under GOAL mode this is the standing-cadence write that keeps the owner report honest.',
    notWhen:
      'For per-project progress use the pot/plan/work-item beneath the goal — this row carries the goal-level state only. To read current state first, goals:get { id, detail:"full" }.',
    chaining:
      'goals:get → goals:update. Pausing/killing winds the projects down FOR you (placement gate + loop disarm); ' +
      'a degraded result means burn continues — chase it with fleet:assignments / loop:status on the reported projects.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: z.object({
    id: z.string().min(1),
    status: z.enum(GOAL_STATUSES).optional(),
    title: z.string().min(1).max(500).optional(),
    body: z.string().max(20000).optional(),
    killCriterion: z.string().max(2000).optional(),
    tripwires: z
      .array(TripwireSchema)
      .max(12)
      .nullable()
      .optional()
      .describe(
        'refresh the structured kill criterion — this is how a tripwire\'s `current` advances ("$310 of $500"). Pass null to drop them back to prose-only. Omit to leave untouched.',
      ),
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
        kill_criterion: string | null;
        tripwires: unknown;
        metadata: Record<string, unknown> | null;
      }>
    >`
      SELECT title, body, status, parent_id, budget_cents, kill_criterion, tripwires, metadata
        FROM harness_shared.goals WHERE id = ${args.id} LIMIT 1
    `;
    if (!existing.length) {
      return { data: null, degraded: true, degradedReasons: [`goal ${args.id} not found`] };
    }
    const prev = existing[0]!;

    // Merge rather than replace: reporting spend must not clear the kill
    // criterion recorded at creation, and vice versa.
    //
    // The kill criterion and its tripwires are COLUMNS now (migration 765), not
    // metadata keys — the GUI's headline reads them directly. A goal written
    // before that migration still carries `metadata.killCriterion`, so fall
    // back to it when the column is empty rather than silently blanking the one
    // field the owner most needs to see.
    const metadata: Record<string, unknown> = { ...(prev.metadata ?? {}) };
    if (args.spentCents !== undefined) metadata.spentCents = args.spentCents;
    const legacyCriterion =
      typeof metadata.killCriterion === 'string' ? (metadata.killCriterion as string) : null;
    // Having migrated it into the column, drop the metadata copy: two sources
    // of truth for the one field that decides whether a goal ends is how a
    // reader ends up showing the stale one.
    delete metadata.killCriterion;

    // Resolve every column in JS so "omitted" and "explicitly null" stay
    // distinguishable — a COALESCE in SQL cannot express detaching a parent,
    // and a conditional SQL fragment to work around that is worse.
    const next = {
      title: args.title ?? prev.title,
      body: args.body ?? prev.body,
      status: args.status ?? prev.status,
      budgetCents: args.budgetCents ?? (prev.budget_cents === null ? null : Number(prev.budget_cents)),
      parentId: args.parentId === undefined ? prev.parent_id : args.parentId,
      killCriterion: args.killCriterion ?? prev.kill_criterion ?? legacyCriterion,
      tripwires:
        args.tripwires === undefined
          ? prev.tripwires === null || prev.tripwires === undefined
            ? null
            : JSON.stringify(prev.tripwires)
          : args.tripwires === null || args.tripwires.length === 0
            ? null
            : JSON.stringify(args.tripwires),
      metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    };

    await ctx.tx`
      UPDATE harness_shared.goals
         SET title          = ${next.title},
             body           = ${next.body},
             status         = ${next.status},
             budget_cents   = ${next.budgetCents},
             parent_id      = ${next.parentId},
             kill_criterion = ${next.killCriterion},
             tripwires      = ${next.tripwires}::jsonb,
             metadata       = ${next.metadata}::jsonb,
             updated_at     = now()
       WHERE id = ${args.id}
    `;

    const [row] = await ctx.tx<
      Array<{
        id: string;
        title: string;
        status: string;
        parent_id: string | null;
        budget_cents: string | null;
        kill_criterion: string | null;
        tripwires: unknown;
        metadata: Record<string, unknown> | null;
      }>
    >`
      SELECT id, title, status, parent_id, budget_cents, kill_criterion, tripwires, metadata
        FROM harness_shared.goals WHERE id = ${args.id} LIMIT 1
    `;

    // ── The stop fan-out (EI-20013729460455061) ──────────────────────────────
    //
    // Until this existed, moving a goal to paused/killed relabelled the row and
    // nothing else: no consumer of harness_shared.goals gates execution on
    // status, so every fleet, loop and pot pursuing the goal kept running.
    //
    // FIRED ON AN EXPLICIT `status` ARGUMENT, not on a transition edge. A stop
    // that only fired on active->paused could never be RE-issued, and re-issuing
    // is exactly what an owner does when the first stop came back degraded (loops
    // still burning). Reporting spend on an already-paused goal passes no
    // `status`, so it does not re-fire.
    let stop: GoalStopReport | null = null;
    let stopError: string | null = null;
    if (args.status !== undefined && isStoppingStatus(args.status)) {
      const executor = getGoalStopExecutor();
      if (executor) {
        // UnifiedToolContext carries NO top-level workspaceId — only
        // principal.workspaceId (EI-18884122799901600) — so pass the two fields
        // explicitly rather than the whole ctx. The GUC still wins inside the
        // resolver; this is only the fallback leg.
        const workspaceId = await resolveGoalWorkspace({
          tx: ctx.tx,
          workspaceId: ctx.principal?.workspaceId,
        });
        if (!workspaceId) {
          // Refuse rather than fan out against the wrong tenant: gating placement
          // in a workspace the goal does not live in would stop unrelated work.
          stopError = 'no concrete workspace in scope — stop fan-out skipped';
        } else {
          try {
            stop = await executor({
              goalId: args.id,
              workspaceId,
              status: args.status,
              actor: ctx.principal?.slug ?? null,
            });
          } catch (e) {
            // The status write STANDS even when the stop fails: the owner's intent
            // is recorded either way, and silently reverting to 'active' would be
            // a second lie on top of the first. Surface it loudly instead.
            stopError = e instanceof Error ? e.message : String(e);
          }
        }
      } else {
        // No host executor wired (a bare agent-mcp embedding). Say so — this is
        // precisely the state the item describes, and it must not read as success.
        stopError = 'no goal-stop executor installed by the host — status changed, nothing stopped';
      }
    }

    const degradedReasons: string[] = [];
    if (stopError) degradedReasons.push(stopError);
    if (stop?.degraded) {
      degradedReasons.push(
        `goal ${args.status}, but ${stop.unattributedActiveLoops} active loop(s) in its projects could not be attributed to this goal and are STILL RUNNING`,
      );
    }

    return {
      data: row ? { ...row, stop } : null,
      ...(degradedReasons.length ? { degraded: true, degradedReasons } : {}),
    };
  },
});
