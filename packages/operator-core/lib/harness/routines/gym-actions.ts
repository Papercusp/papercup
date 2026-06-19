/**
 * Gym system action (learning-system-audit-improvements-2026-06-09 P-031/P-032)
 * — `system:gym-cycle`, the routine that gives the gym a PULSE: continuous
 * operation as a switch (the per-harness autoloop row), not a manual CLI run.
 *
 * Thin glue over the pure tick core (`lib/gym/autoloop-tick.ts` — selection,
 * round-robin, budget floor, routed-ideas assembly, status transitions; all
 * unit-tested with injected deps). Per tick, AT MOST ONE harness runs AT MOST
 * ONE bounded gym cycle, picked least-recently-run among autoloops that are
 * enabled + idle + explicitly budgeted with remaining > the floor (~$0.50).
 *
 * Gates honored, in order:
 *   - enabled/status/budget eligibility (the tick core — the hard cost guard;
 *     a null budget is INELIGIBLE: unattended spend requires an explicit cap),
 *   - the shared autoloop fire-gate (error backoff / circuit breaker, D-009,
 *     role 'gym-cycle') — an erroring harness degrades to backoff probes and
 *     never starves its peers (the tick walks past it),
 *   - inside the cycle: the loop's hard budget cap (= the row's remaining
 *     budget), the rate-limit pause+resume, and the arithmetic circuit breaker.
 *
 * autoPromote stays FALSE — the cycle records proposals; humans decide (D-020).
 *
 * The handler runs as ONE durable step (system-actions contract) and NEVER
 * throws for a failed cycle: the fire-gate's error counter is the backoff
 * signal, and a step failure would invite engine-level replays (= double
 * cycles = double spend). A replayed tick sees the row at status 'running' and
 * skips it. The per-hive gym autoloop ROWS it sweeps are now provisioned inline
 * at hive:create (lib/hive/provision-learning-loop.ts, dark by default) — the
 * standalone `?? 'papercup'` seed-gym-routine.ts env-slug script was RETIRED
 * (per-hive-learning-loops-2026-06-14 P-022 / D-003).
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { checkFireGate, recordFire } from '../../autoloop';
import { listAutoloopsForWorkspace, setAutoloop } from '../../gym/control-plane';
import {
  GYM_AUTOLOOP_BUDGET_FLOOR_USD,
  runGymAutoloopTick,
  selectRoutedGymIdeas,
  type GymCycleRequest,
  type GymCycleResult,
} from '../../gym/autoloop-tick';
import { readImprovementItems } from '../improvements/read-items';
import { finalizePendingChampionOutcomes } from '../../gym/post-acceptance-outcomes';
import { recordGymTickToGovernor } from '../../learning-governor/registrants';

/** The autoloop_state role the gym tick's fire-gate/backoff is keyed under. */
export const GYM_CYCLE_FIRE_ROLE = 'gym-cycle';

/** The cycle-runner seam — injectable for tests (mirrors the implement fire seam). */
export type GymCycleRunFn = (req: GymCycleRequest) => Promise<GymCycleResult>;

let _runCycle: GymCycleRunFn | null = null;
/** Override the cycle runner (tests). Pass null to restore the default in-process run. */
export function setGymCycleRunner(fn: GymCycleRunFn | null): void {
  _runCycle = fn;
}

/**
 * Default: run ONE cycle in-process via the factored `runOneAutoloopCycle`
 * (lib/gym/autoloop-cycle.ts) — the SAME machinery as the manual CLI, no
 * shell-out. Imported lazily so the routines boot path never loads
 * testcontainers / the gym runner graph. The tick core owns the autoloop row
 * (running→idle + spend ACCUMULATION), so the cycle is told not to
 * (manageAutoloopRow:false); the control plane (proposals / QD archive) writes
 * to the LIVE operator DB through the shared admin client.
 */
const defaultRunCycle: GymCycleRunFn = async (req) => {
  const { runOneAutoloopCycle } = await import('../../gym/autoloop-cycle');
  const { sql } = getOrgPg();
  const out = await runOneAutoloopCycle(req.harnessSlug, {
    workspaceId: req.workspaceId,
    maxCycles: 1,
    budgetUsd: req.budgetUsd,
    candidateDirections: req.candidateDirections,
    controlSql: sql, // caller-owned: runOneAutoloopCycle never closes it
    manageAutoloopRow: false,
    log: (m) => console.log(`[gym-cycle] ${m}`),
  });
  if (!out.result) {
    throw new Error(`gym cycle failed before completing: ${String(out.report.error ?? 'unknown error')}`);
  }
  const r = out.result;
  return { spentUsd: r.spentUsd, breakerTripped: r.breakerTripped, cycles: r.cycles, accepts: r.accepts, skipped: r.skipped };
};

/** Budget floor (USD): env override PAPERCUSP_GYM_BUDGET_FLOOR_USD, else the tick default. */
export function gymBudgetFloorUsd(): number {
  const raw = process.env.PAPERCUSP_GYM_BUDGET_FLOOR_USD;
  if (raw == null || raw.trim() === '') return GYM_AUTOLOOP_BUDGET_FLOOR_USD;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[gym-cycle] PAPERCUSP_GYM_BUDGET_FLOOR_USD="${raw}" is not a non-negative number — using ${GYM_AUTOLOOP_BUDGET_FLOOR_USD}`);
    return GYM_AUTOLOOP_BUDGET_FLOOR_USD;
  }
  return n;
}

registerSystemAction('gym-cycle', async (ctx: SystemActionCtx) => {
  const { sql } = getOrgPg();
  // Owner idle-activity toggle (queen-steering-panel P-006): the owner can gate gym
  // spend OFF for the home hive from the 👑 tab. Fail-soft → runs (default ON).
  const { idleActivityAllowed } = await import('../../owner-steering');
  if (!(await idleActivityAllowed(ctx.workspaceId, 'gym'))) {
    console.log('[gym-cycle] skipped — owner idle-activity toggle (gym) is OFF');
    return;
  }
  const outcome = await runGymAutoloopTick(
    {
      listAutoloops: () => listAutoloopsForWorkspace(sql, { workspaceId: ctx.workspaceId }),
      checkFireGate: (slug) => checkFireGate(slug, GYM_CYCLE_FIRE_ROLE),
      recordFire: (slug, status, oc) => recordFire(slug, GYM_CYCLE_FIRE_ROLE, status, oc),
      setAutoloop: (input) => setAutoloop(sql, input),
      // P-032: open improvements the triage pass routed to the gym
      // (payload.ideaLifecycle.triageDecision='gym') → proposer candidate directions.
      readRoutedIdeas: async () => selectRoutedGymIdeas(await readImprovementItems({ state: 'open' })),
      runCycle: _runCycle ?? defaultRunCycle,
      // P-020 cross-node single-runner: in a SHARED Hive each node sweeps its own
      // node-local autoloop rows, so without this two nodes could each fire a cycle
      // for the same Hive member (double spend). Keep only autoloops whose Hive THIS
      // node is the elected authority for. At N=1 / standalone this is always true
      // (authority / not-in-hive), so the standalone gym path is unchanged.
      isHiveRunner: async (slug) => {
        const { checkHiveSingleRunner } = await import('../../hive-single-runner');
        return (await checkHiveSingleRunner(ctx.workspaceId, slug)).run;
      },
      // P-030 (B-09): settle elapsed post-acceptance champion-outcome windows each tick.
      finalizeOutcomes: () =>
        finalizePendingChampionOutcomes(sql, { workspaceId: ctx.workspaceId, log: (m) => console.log(`[gym-cycle] ${m}`) }),
      log: (m) => console.log(`[gym-cycle] ${m}`),
    },
    { budgetFloorUsd: gymBudgetFloorUsd() },
  );

  // FB-01 (self-learning-frontier P-003): mirror the autoloop budgets onto the
  // shared learning-governor ledger as sub-budgets + ledger this tick's spend.
  // Flag-gated (papercusp-learning-governor — the kill-switch) and best-effort
  // by contract — recordGymTickToGovernor never throws, so governor
  // bookkeeping can never fail (or durably replay) the gym tick.
  await recordGymTickToGovernor({
    workspaceId: ctx.workspaceId,
    sql,
    listAutoloops: () => listAutoloopsForWorkspace(sql, { workspaceId: ctx.workspaceId }),
    ran:
      outcome.action === 'ran' && outcome.result
        ? {
            harnessSlug: outcome.harnessSlug!,
            spentUsd: outcome.result.spentUsd,
            runRef: `gym-cycle:${outcome.harnessSlug}`,
          }
        : null,
  });

  if (outcome.action === 'idle') {
    console.log(
      `[gym-cycle] idle — ${outcome.reason}` +
        (outcome.gateBlocked.length ? ` (fire-gate withheld: ${outcome.gateBlocked.join(', ')})` : '') +
        ` (${outcome.eligibleCount} eligible autoloop(s))`,
    );
  } else if (outcome.action === 'ran') {
    const r = outcome.result!;
    console.log(
      `[gym-cycle] ${outcome.harnessSlug}: ${r.cycles} cycle(s), ${r.accepts} accept(s), ${r.skipped} skipped, ` +
        `$${r.spentUsd.toFixed(2)} spent → status ${outcome.settledStatus}` +
        (outcome.candidateDirections?.length ? `, ${outcome.candidateDirections.length} routed idea(s) in proposer context` : ''),
    );
  } else {
    // Logged, NOT thrown — the fire-gate's error backoff is the retry brake;
    // a thrown step would invite a durable replay (= a second paid cycle).
    console.error(`[gym-cycle] cycle FAILED for ${outcome.harnessSlug}: ${outcome.error} (status settled back to idle)`);
  }
});
