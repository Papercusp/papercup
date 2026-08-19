/**
 * Goal spend rollup — the durable tick that makes goals.metadata.spentCents TRUE
 * (goal-mode-design-intent-hardening-2026-08-16 P-005, D-003).
 *
 * D-003 (binding): "Spend truth comes from the platform cost ledger rolled up by
 * goal_id; agents never hand-write spentCents." Before this tick the snapshot only
 * existed when an agent called goals:update { spentCents } with a value exactly
 * matching the goals:pots rollup — measured: 3 of 17 goals ever carried one, and
 * the graded GOAL-mode subject had to self-instrument via loop costCapCents and
 * hand-track ~4300→4500c. This module writes the snapshot PLATFORM-SIDE, on a
 * recurring tick, for every ACTIVE goal — no agent in the loop.
 *
 * ── The two attribution legs (and why summing them does not double-count) ──────
 *  1. POT leg — `goalSpend()` (@papercusp/db-org): agent_usage_samples summed by
 *     harness_slug over the goal's live goal_pots, bounded to the goal's lifetime.
 *     Covers every fleet/agent working in the goal's pots. NOT additive across
 *     goals (a shared pot bills in full to each — D-021).
 *  2. SESSION leg — the gap the pot leg cannot see: the goal SUBJECT's own
 *     interactive session and inherited descendants whose samples carry a
 *     harness OUTSIDE the goal's pots (or none at all). Membership is the same
 *     two tables resolveGoalContext reads (never agent self-report): agent_modes
 *     (mode='goal', subject=goalId — the session RUNNING the goal) UNION
 *     session_briefs.goal_id (launch-inherited descendants). Owners map to native
 *     session ids via adv_sessions.coord_owner_id — the whole carry-respawn
 *     chain, not just the current rung — and samples join on session_id (the
 *     loop-cost-cap attribution path, loop-cost-cap.ts). Samples whose
 *     harness_slug IS one of the goal's pot harnesses are EXCLUDED here because
 *     the pot leg already counted them; the union is therefore exact.
 *
 * The snapshot is stamped `spentCentsSource: GOAL_SPEND_TICK_SOURCE` — a marker
 * DISTINCT from GOAL_SPEND_SNAPSHOT_SOURCE ('goal-pots-rollup') because the value
 * is deliberately a SUPERSET of the pots rollup; writing it under the pots marker
 * would break goals:update's exact-match verification invariant. The sync read
 * (sync-resolver/goals.ts) accepts either marker. A spentCentsBreakdown rides
 * along so a reader can tell a measured figure from a floor (unpriced samples).
 *
 * Mechanism precedent: the goal watchdog family (goal-liveness-watchdog.ts,
 * goal-drain-fleet-watchdog.ts) — a process-level managedSetInterval sweep
 * started from dbos/bootstrap.ts, deliberately NOT a DBOS workflow (EI-1622
 * workflow_status bloat), flag-gated per tick (FLAGS.GOAL_SPEND_ROLLUP_TICK,
 * default ON). Missing a tick costs nothing: the next tick recomputes from the
 * ledger — the write is idempotent state, not an event.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { goalSpend, GOAL_SPEND_TICK_SOURCE, type GoalSpend } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { GOAL_MODE } from '../modes/goal-session';
import {
  breachedTripwires,
  refreshTripwireCurrents,
  type GoalTripwireLike,
} from './tripwire-refresh';

export const GOAL_SPEND_ROLLUP_INTERVAL_MS = 5 * 60_000;

/** The SESSION leg's contribution — samples the pot leg cannot see. */
export interface GoalSessionSpend {
  costUsd: number;
  samples: number;
  pricedSamples: number;
  unpricedSamples: number;
  /** Distinct native session ids that contributed samples. */
  sessions: number;
}

export interface GoalSpendRollup {
  goalId: string;
  /** POT leg + SESSION leg, in integer cents (what the snapshot writes). */
  totalCents: number;
  potCents: number;
  sessionCents: number;
  samples: number;
  unpricedSamples: number;
  /** True only when ≥1 sample contributed and EVERY sample carried a cost —
   *  same contract as GoalSpend.measured. False means the figure is a FLOOR. */
  measured: boolean;
  pot: GoalSpend;
  session: GoalSessionSpend;
}

/**
 * The SESSION leg: samples attributed (via adv_sessions) to owners under the
 * goal, excluding samples already covered by the pot leg's harness match.
 *
 * Owner→goal membership deliberately reads the SAME two tables as
 * resolveGoalContext (modes/goal-context.ts) rather than any agent-supplied
 * list. adv_sessions is NOT workspace-filtered on purpose: coord owner ids are
 * globally unique and a respawn chain can carry rows under more than one
 * workspace label, while the SAMPLE-side workspace_id filter still holds the
 * tenancy line. The goal-lifetime lower bound mirrors goalSpend(): a subject's
 * spend from before the goal existed never bills to it.
 */
export async function sessionSpendForGoal(
  sql: Sql,
  opts: { workspaceId: string; goalId: string; sinceMs?: number },
): Promise<GoalSessionSpend> {
  const since = opts.sinceMs ?? 0;
  const rows = await sql<
    Array<{
      cost: string | null;
      samples: string;
      priced_samples: string;
      unpriced_samples: string;
      sessions: string;
    }>
  >`
    SELECT COALESCE(SUM(s.cost_usd), 0) AS cost,
           COUNT(*)                     AS samples,
           COUNT(*) FILTER (WHERE s.cost_usd IS NOT NULL) AS priced_samples,
           COUNT(*) FILTER (WHERE s.cost_usd IS NULL) AS unpriced_samples,
           COUNT(DISTINCT s.session_id) AS sessions
      FROM harness_shared.agent_usage_samples s
      JOIN harness_shared.goals g
        ON g.id = ${opts.goalId}
       AND g.workspace_id = ${opts.workspaceId}
     WHERE s.workspace_id = ${opts.workspaceId}
       AND s.session_id IN (
         SELECT a.session_id
           FROM harness_shared.adv_sessions a
          WHERE a.session_id IS NOT NULL
            AND a.coord_owner_id IN (
              SELECT m.owner_id FROM harness_shared.agent_modes m
               WHERE m.workspace_id = ${opts.workspaceId}
                 AND m.mode = ${GOAL_MODE}
                 AND m.subject = ${opts.goalId}
              UNION
              SELECT b.owner_id FROM harness_shared.session_briefs b
               WHERE b.workspace_id = ${opts.workspaceId}
                 AND b.goal_id = ${opts.goalId}
            )
       )
       AND (s.harness_slug IS NULL OR s.harness_slug NOT IN (
         SELECT gp.harness_slug FROM harness_shared.goal_pots gp
          WHERE gp.workspace_id = ${opts.workspaceId}
            AND gp.goal_id = ${opts.goalId}
            AND gp.removed_at IS NULL))
       AND s.ts >= GREATEST(
         ${since}::bigint,
         (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint
       )
  `;
  const r = rows[0];
  return {
    costUsd: Number(r?.cost ?? 0),
    samples: Number(r?.samples ?? 0),
    pricedSamples: Number(r?.priced_samples ?? 0),
    unpricedSamples: Number(r?.unpriced_samples ?? 0),
    sessions: Number(r?.sessions ?? 0),
  };
}

/** Both legs, combined into the number the snapshot writes. */
export async function computeGoalSpendRollup(
  sql: Sql,
  opts: { workspaceId: string; goalId: string },
): Promise<GoalSpendRollup> {
  const [pot, session] = await Promise.all([
    goalSpend(sql, opts),
    sessionSpendForGoal(sql, opts),
  ]);
  const potCents = Math.round(pot.costUsd * 100);
  const sessionCents = Math.round(session.costUsd * 100);
  const samples = pot.samples + session.samples;
  const unpricedSamples = pot.unpricedSamples + session.unpricedSamples;
  return {
    goalId: opts.goalId,
    totalCents: potCents + sessionCents,
    potCents,
    sessionCents,
    samples,
    unpricedSamples,
    measured: samples > 0 && unpricedSamples === 0,
    pot,
    session,
  };
}

/**
 * Persist the snapshot onto goals.metadata. Deliberately does NOT bump
 * updated_at: that column is the goal's DEFINITION-edit time (the sync board
 * reads it as such), and a background rollup is not an edit.
 */
export async function writeGoalSpendSnapshot(
  sql: Sql,
  opts: { workspaceId: string; goalId: string },
  rollup: GoalSpendRollup,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const patch = {
    spentCents: rollup.totalCents,
    spentCentsSource: GOAL_SPEND_TICK_SOURCE,
    spentCentsAt: nowIso,
    spentCentsBreakdown: {
      potCents: rollup.potCents,
      sessionCents: rollup.sessionCents,
      samples: rollup.samples,
      unpricedSamples: rollup.unpricedSamples,
      sessions: rollup.session.sessions,
      measured: rollup.measured,
    },
  };
  // sql.json, NOT a pre-stringified text param: postgres-js JSON-serializes a
  // parameter bound to jsonb, so passing JSON.stringify(patch) double-encodes it
  // into a jsonb SCALAR STRING — and `object || scalar` concatenates into an
  // ARRAY instead of merging, silently destroying the metadata shape (measured
  // live: metadata became [{}, "{…}"] while the UPDATE reported count=1).
  const res = await sql`
    UPDATE harness_shared.goals
       SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json(patch)}
     WHERE id = ${opts.goalId}
       AND workspace_id = ${opts.workspaceId}
  `;
  return res.count;
}

/**
 * Advance this goal's generically-measurable tripwires from the rollup just
 * computed (plan blender-goal-amendment-rail-2026-08-19 P-004, D-014).
 *
 * ⚠ THE `measured` GATE IS THE POINT, not a detail. `rollup.totalCents` is a
 * FLOOR whenever any sample is unpriced, and a spend tripwire governs a ceiling
 * — so publishing a floor as `current` would read as "safely under" when the
 * true figure is unknown. Only a fully-priced rollup advances a spend tripwire;
 * everything else is passed as null and leaves the value exactly as it was.
 *
 * Like {@link writeGoalSpendSnapshot} this deliberately does NOT bump
 * `updated_at`: scoring a tripwire reports a measurement, it does not edit the
 * goal's intent (which is precisely why P-004 needs no amendment authority).
 */
export async function refreshGoalTripwires(
  sql: Sql,
  opts: { workspaceId: string; goalId: string },
  goal: { tripwires: GoalTripwireLike[] | null; createdAtMs: number },
  rollup: GoalSpendRollup,
  nowMs: number = Date.now(),
): Promise<{ advanced: number; written: boolean; breached: ReturnType<typeof breachedTripwires> }> {
  const res = refreshTripwireCurrents(goal.tripwires, {
    measuredSpentCents: rollup.measured ? rollup.totalCents : null,
    goalAgeMs: nowMs - goal.createdAtMs,
  });
  if (!res.changed) return { advanced: 0, written: false, breached: [] };

  // sql.json for the same double-encoding reason documented on the snapshot write.
  const upd = await sql`
    UPDATE harness_shared.goals
       SET tripwires = ${sql.json(res.next)}
     WHERE id = ${opts.goalId}
       AND workspace_id = ${opts.workspaceId}
  `;
  if (upd.count !== 1) throw new Error(`tripwire UPDATE matched ${upd.count} rows`);

  // Report breaches; never act on them. Firing a kill criterion is a deliberate
  // decision with an owner in it, not a side effect of a reporting sweep.
  const breached = breachedTripwires(res.next);
  for (const b of breached) {
    console.warn(
      `[goal-spend-rollup] goal ${opts.goalId}: tripwire ${b.metric} BREACHED — ` +
        `${b.current}${b.unit ? ` ${b.unit}` : ''} of ${b.threshold}`,
    );
  }
  return { advanced: res.advanced, written: true, breached };
}

export interface GoalSpendRollupSweepResult {
  ok: boolean;
  /** false when the flag gate stood the sweep down before any read. */
  ran: boolean;
  checked: number;
  written: number;
  /** Tripwires advanced to a freshly measured value this sweep (P-004). */
  tripwiresAdvanced: number;
  errors: Array<{ goalId: string; error: string }>;
}

/**
 * One sweep: snapshot every ACTIVE goal. Per-goal error isolation — one goal's
 * failure never starves the rest (same contract as the watchdog siblings).
 */
export async function runGoalSpendRollupOnce(sql: Sql): Promise<GoalSpendRollupSweepResult> {
  const enabled = await getFlag(FLAGS.GOAL_SPEND_ROLLUP_TICK, 'system').catch(() => false);
  if (!enabled)
    return { ok: true, ran: false, checked: 0, written: 0, tripwiresAdvanced: 0, errors: [] };
  const goals = await sql<
    Array<{
      id: string;
      workspace_id: string;
      tripwires: GoalTripwireLike[] | null;
      created_at: Date;
    }>
  >`
    SELECT id, workspace_id, tripwires, created_at
      FROM harness_shared.goals WHERE status = 'active'
  `;
  const errors: Array<{ goalId: string; error: string }> = [];
  let written = 0;
  let tripwiresAdvanced = 0;
  for (const g of goals) {
    try {
      const scope = { workspaceId: g.workspace_id, goalId: g.id };
      const rollup = await computeGoalSpendRollup(sql, scope);
      const count = await writeGoalSpendSnapshot(sql, scope, rollup);
      // A zero-row write means the snapshot silently went nowhere (the goal row
      // vanished mid-sweep, or a scope mismatch) — an error, never a success.
      if (count !== 1) throw new Error(`snapshot UPDATE matched ${count} rows`);
      written += 1;

      // P-004: carry the number one field further, onto the tripwire it was
      // always meant to advance. Isolated from the snapshot write above — a
      // tripwire refresh failing must never lose the spend snapshot that
      // already succeeded, so it throws only after `written` is banked.
      const refreshed = await refreshGoalTripwires(sql, scope, {
        tripwires: g.tripwires ?? null,
        createdAtMs: new Date(g.created_at).getTime(),
      }, rollup);
      tripwiresAdvanced += refreshed.advanced;
    } catch (e) {
      errors.push({ goalId: g.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    ok: errors.length === 0,
    ran: true,
    checked: goals.length,
    written,
    tripwiresAdvanced,
    errors,
  };
}

let tickTimer: ManagedHandle | null = null;

/**
 * Start the recurring rollup tick. Idempotent. Runtime gate:
 * FLAGS.GOAL_SPEND_ROLLUP_TICK (checked per tick, default ON).
 */
export function startGoalSpendRollupTick(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  const intervalMs = opts.intervalMs ?? GOAL_SPEND_ROLLUP_INTERVAL_MS;
  if (tickTimer) tickTimer.stop();
  let sweeping = false;
  tickTimer = managedSetInterval(
    'goal-spend-rollup',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalSpendRollupOnce(sql)
        .catch((e) => {
          console.warn(
            `[goal-spend-rollup] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // 'must-sample': the cost ledger emits no event this could subscribe to —
    // periodic aggregation is the only trigger available for a spend snapshot.
    // 'global-sweep', not 'watchdog': this is a host-wide idempotent aggregation,
    // not an out-of-band sentinel — it recovers nothing, so it does not belong in
    // RECOVERY_MECHANISMS (the recovery-dependency-audit enumerates 'watchdog').
    { category: 'global-sweep', classification: 'must-sample' },
  );
}
