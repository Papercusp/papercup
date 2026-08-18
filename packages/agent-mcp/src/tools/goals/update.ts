/**
 * goals:update — move a goal's standing state.
 *
 * The other half of P-009's "wire the dead table". Creating a goal record is
 * only half a ratchet-guard: GOAL mode's contract says an agent that only ever
 * CREATES is a ratchet, so the goal must also be closable — `status: 'killed'`
 * when the kill criterion trips, `'achieved'` when it is met — and a verified
 * measured child-fleet spend snapshot may be recorded against the ceiling
 * declared at creation. This tool cannot infer the interactive session's own
 * spend.
 *
 * Partial by construction: every field is optional and an omitted field is left
 * alone, so recording a measured spend snapshot never silently clears a kill
 * criterion.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { GOAL_SPEND_SNAPSHOT_SOURCE, goalSpend } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { killCriterionProblem } from '@papercusp/operator-core/lib/goals/kill-criterion';
import {
  GOAL_LAUNCH_DEFAULTS,
  UNLIMITED_CEILING,
  goalLaunchSettingsSchema,
  writeGoalLaunchSettings,
} from '@papercusp/operator-core/lib/goal-launch-settings';
import { SU_WRITE_ROLES } from '../../role-config';
import { GOAL_STATUSES, TripwireSchema } from './create';
import { applyGoalBlockedBy } from './goal-deps';
import { resolveGoalWorkspace } from './_workspace';
import {
  getGoalTransitionExecutor,
  isTransitioningStatus,
  isStopReport,
  type GoalTransitionReport,
} from './stop-seam';

export default defineTool({
  name: 'goals:update',
  description:
    'Move a GOAL record\'s standing state (harness_shared.goals): { id, status?, title?, body?, killCriterion?, budgetCents?, spentCents?, parentId?, launchSettings?, drainFleet? }. ' +
    'Partial — omitted fields stay untouched. status:"killed" when the kill criterion trips, "achieved" when the outcome is met. ' +
    'status FANS OUT, in both directions: "paused"|"killed"|"achieved" gates placement on the projects this goal OWNS and disarms the engine loops of sessions attributed to it; ' +
    '"active" re-opens placement on those same projects (nothing else can — the pause is marked deliberate so no watchdog undoes it). Read `stop` and `degraded` either way.',
  capability: 'goals:write',
  guidance: {
    when:
      'Recording a verified child-fleet spend snapshot against a goal\'s declared ceiling, revising its statement or kill criterion, or CLOSING it (achieved / killed). A spend snapshot is accepted only when it exactly matches the measured goals:pots rollup.',
    notWhen:
      'For per-pot progress or measured spend use goals:pots { goalId } and the pot/plan/work-item beneath the goal — this row carries the goal-level state only. Do not invent interactive-session cost. To read current state first, goals:get { id, detail:"full" }.',
    chaining:
      'goals:get → goals:pots → goals:update only when writing a verified measured snapshot. Pausing/killing winds the projects down FOR you (placement gate + loop disarm); ' +
      'a degraded spend result means no snapshot was written and the tripwire remains unmeasured — chase it with goals:pots, then fleet:assignments / loop:status on the reported projects.',
    returns:
      '`stop` carries the fan-out report and is NOT symmetric — check its `status` before reading it. ' +
      'STOP arm (paused/killed/achieved): `potsStopped`, `potsSkippedContributing`, `loopsStopped`, and ⚠ `unattributedActiveLoops` — active loops in this goal\'s own pots that could NOT be attributed to it and are STILL RUNNING. ' +
      'TERMINAL only (killed/achieved): `modesCleared` — sessions whose GOAL-mode row was retired — and ⚠ `modesLeftArmed`, owner-directed rows the sticky guard REFUSED, so those sessions are still being told this goal is their mission. A pause keeps the rows (resume reads them). ' +
      'RESUME arm (active): `potsResumed`, `potsSkippedContributing`, and ⚠ `loopsLeftDisarmed` — sessions attributed to this goal that are still not looping, deliberately NOT re-armed (they are routinely dead by resume time; new work re-forms from PLACEMENT instead). ' +
      '`timeWakeRestored` is always false: the pause DELETES the pot\'s declared time-wake row and its cadence is not reconstructible. ' +
      '`degraded` is true when either gap is non-zero — a caller that renders only `status` will be wrong, which is what these numbers exist to prevent.',
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
    spentCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'cents from the all-time measured child-fleet goals:pots rollup; the handler rejects missing, partial, or mismatched measurements and never derives interactive-session cost',
      ),
    parentId: z.string().min(1).nullable().optional().describe('re-parent, or null to detach'),
    blockedBy: z
      .array(z.string().min(1).max(200))
      .max(20)
      .nullable()
      .optional()
      .describe(
        'REPLACE this goal\'s blocked-by set (goal-dag-shared-substrate-2026-08-18): goal ids and/or bare WI-/EI- issue ids that must resolve before this goal is actionable. Declarative full-set — the previous set is replaced; null or [] clears it. Every ref must RESOLVE (a goal in this workspace / an existing issue) and the goal graph must stay acyclic. Edges are prerequisites between SEPARATE outcomes — phases of one outcome belong inside the goal as plans/tripwires (D-005). An achieved goal blocker satisfies; a KILLED one flags this goal premiseInvalidated instead of unblocking it.',
      ),
    drainFleet: z
      .string()
      .min(1)
      .max(120)
      .nullable()
      .optional()
      .describe(
        'the STANDING drain fleet slug for this goal (GOAL contract clause 3 — one per goal, always maintained). Record it the moment the fleet is established; null clears it (e.g. re-establishing under a new slug). The goal-liveness watchdog treats an active goal without one as a gap.',
      ),
    launchSettings: goalLaunchSettingsSchema
      .nullable()
      .optional()
      .describe(
        'per-goal launch ceilings + profile ({ maxAgents, maxPerFleet, defaults, roles }) — the numbers every launch for this goal is checked against. ' +
          `Each ceiling takes a number, or "${UNLIMITED_CEILING}" for no ceiling at all; OMITTING one applies the system default ` +
          `(${GOAL_LAUNCH_DEFAULTS.maxAgents} agents / ${GOAL_LAUNCH_DEFAULTS.maxPerFleet} per fleet), which is NOT the same as unlimited. ` +
          'Pass null to clear the whole document back to those defaults; omit to leave untouched.',
      ),
  }),
  async handler(args, ctx) {
    // ── The criterion gate (P-009) ───────────────────────────────────────────
    //
    // BEFORE the read, because it needs no row and a refusal should cost
    // nothing. `goals:propose` refuses a criterion that states no abandonment
    // condition; until P-009 this door did not, so the edit path was a way to
    // install a criterion the create path would have rejected. Both doors now
    // call the SAME `killCriterionProblem` — sharing the rule rather than
    // re-stating it is the item's hard constraint, since a second copy drifts
    // silently and only ever in the permissive direction.
    //
    // A BLANK criterion is an explicit CLEAR, not a refusal, and is allowed
    // through deliberately: a goal may be created with no criterion at all
    // (WI-37604, owner-directed 2026-08-09), so refusing to clear one would
    // make this door STRICTER than creation rather than equal to it. Clearing
    // restores the panel's "nothing can stop this goal" alarm, which is the
    // honest reading of the resulting state. It is normalised to null so the
    // column holds an absence rather than whitespace that every reader has to
    // re-trim before it reads as absent.
    const criterionArg = args.killCriterion?.trim();
    if (criterionArg) {
      const problem = killCriterionProblem(criterionArg);
      if (problem) {
        return { data: null, degraded: true, degradedReasons: [problem] };
      }
    }

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

    /* SPEND PROVENANCE (EI-20188678636377696).
       `spentCents` used to be an owner-entered number. That made a guess
       indistinguishable from a measurement and let a decorative ceiling read
       as enforced. The only currently honest source is the existing measured
       child-fleet rollup behind goals:pots. Read it in this transaction, reject
       an incomplete rollup, and compare the caller's number to the source
       before touching the goal row. The interactive GOAL session deliberately
       remains outside this figure: provider billing is not attributable there. */
    let measuredSpendCents: number | undefined;
    if (args.spentCents !== undefined) {
      const workspaceId = await resolveGoalWorkspace({
        tx: ctx.tx,
        workspaceId: ctx.principal?.workspaceId,
      });
      if (!workspaceId) {
        return {
          data: null,
          degraded: true,
          degradedReasons: [
            `spentCents refused for goal ${args.id}: no concrete workspace is available to read the measured goals:pots rollup`,
          ],
        };
      }
      const spend = await goalSpend(ctx.tx as Sql, { workspaceId, goalId: args.id });
      if (!spend.measured || !Number.isFinite(spend.costUsd)) {
        return {
          data: null,
          degraded: true,
          degradedReasons: [
            `spentCents refused for goal ${args.id}: goals:pots has no complete priced measurement (samples=${spend.samples}, priced=${spend.pricedSamples}, unpriced=${spend.unpricedSamples}); the spend tripwire remains unmeasured`,
          ],
        };
      }
      measuredSpendCents = Math.round(spend.costUsd * 100);
      if (args.spentCents !== measuredSpendCents) {
        return {
          data: null,
          degraded: true,
          degradedReasons: [
            `spentCents refused for goal ${args.id}: supplied ${args.spentCents} does not match the measured goals:pots rollup (${measuredSpendCents} cents); the spend tripwire remains unmeasured`,
          ],
        };
      }
    }

    // Merge rather than replace: reporting spend must not clear the kill
    // criterion recorded at creation, and vice versa.
    //
    // The kill criterion and its tripwires are COLUMNS now (migration 765), not
    // metadata keys — the GUI's headline reads them directly. A goal written
    // before that migration still carries `metadata.killCriterion`, so fall
    // back to it when the column is empty rather than silently blanking the one
    // field the owner most needs to see.
    const metadata: Record<string, unknown> = { ...(prev.metadata ?? {}) };
    if (measuredSpendCents !== undefined) {
      metadata.spentCents = measuredSpendCents;
      metadata.spentCentsSource = GOAL_SPEND_SNAPSHOT_SOURCE;
    }
    // Standing drain fleet (EI-20581099901890760): omitted leaves it alone;
    // null clears it (re-establishment under a new slug passes the new one).
    if (args.drainFleet !== undefined) {
      if (args.drainFleet === null) delete metadata.drainFleet;
      else metadata.drainFleet = args.drainFleet;
    }
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
      // Omitted leaves it alone; a blank CLEARS it to null (see the gate above)
      // rather than storing whitespace that every reader has to re-trim before
      // it reads as absent — `killCriterionLine` and the board card both decide
      // "missing" by trimming, so an untrimmed blank is already an absence
      // wearing a value.
      killCriterion:
        criterionArg === undefined ? (prev.kill_criterion ?? legacyCriterion) : criterionArg || null,
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

    /* PER-GOAL LAUNCH SETTINGS (P-005 wires P-004's store to a door).
       Delegated to `writeGoalLaunchSettings` rather than folded into the UPDATE
       above: that function is the store's writer, it re-validates before the
       column is touched, and having a second place that knows how to serialise
       this document is how the two would drift.

       Passed `ctx.tx`, so it runs INSIDE this handler's transaction — the
       settings and the rest of the row commit together or not at all. Its own
       default (`getOrgPg()`) would open a second connection and could leave a
       ceiling raised on a goal whose update rolled back.

       Undefined leaves the column alone; null clears it — the same
       omitted-vs-explicitly-null distinction `parentId` and `tripwires` make. */
    let launchSettingsError: string | null = null;
    if (args.launchSettings !== undefined) {
      const w = await writeGoalLaunchSettings(args.id, args.launchSettings, ctx.tx);
      if (!w.ok) launchSettingsError = `launch settings NOT saved: ${w.error ?? 'unknown error'}`;
    }

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
        launch_settings: unknown;
      }>
    >`
      SELECT id, title, status, parent_id, budget_cents, kill_criterion, tripwires, metadata,
             launch_settings
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
    let stop: GoalTransitionReport | null = null;
    let stopError: string | null = null;
    if (args.status !== undefined && isTransitioningStatus(args.status)) {
      const executor = getGoalTransitionExecutor();
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
    // Loud, not swallowed: an owner who just raised a ceiling and got `ok` back
    // would otherwise believe a limit is in force that was never written.
    if (launchSettingsError) degradedReasons.push(launchSettingsError);
    if (stopError) degradedReasons.push(stopError);
    if (stop?.degraded) {
      if (isStopReport(stop)) {
        // ONE CLAUSE PER ACTUAL CAUSE. `degraded` is now reachable two ways, so a
        // single hardcoded sentence would report whichever cause it happens to name —
        // and a sticky-refusal degrade would read "…but 0 active loop(s) are STILL
        // RUNNING", a confident statement about the wrong quantity. That is the exact
        // steering-surface lie the seam exists to prevent (EI-19995648221353323), so
        // each cause states itself and a cause that did not fire says nothing.
        if (stop.unattributedActiveLoops > 0) {
          degradedReasons.push(
            `goal ${args.status}, but ${stop.unattributedActiveLoops} active loop(s) in its pots could not be attributed to this goal and are STILL RUNNING`,
          );
        }
        if (stop.modesLeftArmed.length > 0) {
          degradedReasons.push(
            `goal ${args.status}, but ${stop.modesLeftArmed.length} session(s) could NOT have their GOAL mode retired — the row is owner-directed and this fan-out is not an owner-authority channel, so they are still being told this finished goal is their standing mission (${stop.modesLeftArmed.join(', ')})`,
          );
        }
      } else {
        // The resume mirror: placement is open again, but the sessions that were
        // pursuing this goal are not looping and this resume deliberately did not
        // re-arm them (plan D-013). Work will re-form from placement, not from them.
        degradedReasons.push(
          `goal resumed and placement re-opened on ${stop.potsResumed.length} pot(s), but ${stop.loopsLeftDisarmed} attributed session loop(s) remain DISARMED and were not re-armed — new work re-forms from placement, the paused sessions do not come back`,
        );
      }
    }

    return {
      data: row ? { ...row, stop } : null,
      ...(degradedReasons.length ? { degraded: true, degradedReasons } : {}),
    };
  },
});
