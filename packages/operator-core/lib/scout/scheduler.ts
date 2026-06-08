/**
 * scheduler.ts — Scout P-008: the autonomous-tick composition (D-002/D-010,
 * "Scout proposes → the Queen gates → agents build → owner gets a report;
 * prompt-free with a judgment layer").
 *
 * `runScoutTick` is the thing a cron routine invokes (via the `system:scout-cycle`
 * action). It is NOT a blind cron — it gates on {@link shouldRunScoutCycle} (idle
 * capacity OR friction), then on the autoloop fire-gate (backoff/circuit), then
 * runs ONE budgeted cycle, persists the routed-idea provenance (P-013 ledger), and
 * refreshes lens outcomes. The cycle itself ({@link ScoutTickDeps.runCycle}, =
 * cb4b9's runScoutCycle) is INJECTED, so this composition is unit-tested with a
 * fake cycle (no LLM, no clock, no fleet) — the autonomy guarantees (cadence-gated,
 * budgeted, prompt-free) are all assertable, which is exactly what P-014 needs.
 *
 * The "Queen gate" is structural, not a separate persisted-triage record (per the
 * agreement with the verification lane): broad-scope proposals route to `plans:new`
 * DRAFT plans (owner/Queen-visible, NOT auto-active) — greenlight = promoting the
 * draft; testable→gym; concrete→improvements:capture. The prompt-free fire (no
 * ctx.askUser anywhere in the loop) is the autonomy; the cadence gate makes "fires
 * only when idle/friction" verifiable.
 */

import { resolveScoutBudget, type ScoutBudget } from './budget';
import {
  shouldRunScoutCycle,
  type ScoutCadenceOptions,
  type ScoutCadenceState,
  type ScoutCadenceVerdict,
} from './cadence';
import { recordRoutedIdea } from './routed-ledger';
import { refreshScoutOutcomes } from './routed-ledger';
import type { CreativeLens } from './types';
import type { RoutedRail } from './outcome-feedback';

/** The provenance the scheduler persists per routed idea (subset of RecordRoutedIdeaInput). */
export interface ScoutRoutedRecord {
  ideaId: string;
  lens: CreativeLens;
  rail: RoutedRail;
  routedRef: string;
  title?: string;
  addressesPatternRefs?: string[];
}

/**
 * Minimal structural view of cb4b9's `ScoutCycleResult` — the scheduler only needs
 * the per-idea lens `provenance` (+ optional spend). cb4b9's full `ScoutCycleResult`
 * (which carries `provenance: ScoutRoutedIdea[]` + `costUsd`) satisfies this
 * directly, so `runScoutCycle` can be injected as `runCycle` with no field
 * remapping — just a thin limits/cycleId binding.
 */
export interface ScoutCycleLike {
  /** Per-idea lens provenance the cycle derived (cb4b9's ScoutCycleResult.provenance). */
  provenance: ScoutRoutedRecord[];
  costUsd?: number;
}

export interface ScoutFireGate {
  allow: boolean;
  reason?: string;
  retryAfterSec?: number;
}

export interface ScoutTickDeps {
  /** Read live cadence signals (idle ratio, friction count, last-run epoch ms). */
  readCadenceState: () => Promise<ScoutCadenceState>;
  /** Run one Scout cycle under the resolved budget (cb4b9's runScoutCycle, adapted). */
  runCycle: (ctx: { budget: Required<ScoutBudget>; cycleId: string }) => Promise<ScoutCycleLike>;
  /** Persist routed-idea provenance for the cycle (P-013 ledger). */
  persistRouted: (records: ScoutRoutedRecord[], cycleId: string) => Promise<void>;
  /** Optional autoloop fire-gate (backoff/circuit); default: always allow. */
  fireGate?: () => Promise<ScoutFireGate>;
  /** Optional fire-state recorder (autoloop recordFire). */
  recordFire?: (outcome: 'attempt' | 'ok' | 'error') => Promise<void>;
  /** Optional: recompute + persist lens outcomes after the cycle (P-013). */
  refreshOutcomes?: () => Promise<void>;
  /** Mint a cycle id; default `scout-<nowMs>`. */
  newCycleId?: (nowMs: number) => string;
}

export interface ScoutTickOptions {
  cadence?: ScoutCadenceOptions;
  budget?: ScoutBudget;
}

export interface ScoutTickResult {
  fired: boolean;
  /** Cadence reason when fired/withheld, or 'circuit'/'cycle-error'. */
  reason: ScoutCadenceVerdict['reason'] | 'circuit' | 'cycle-error';
  cycleId?: string;
  routedCount?: number;
  retryAfterSec?: number;
  error?: string;
}

/**
 * One autonomous Scout tick: cadence-gate → fire-gate → budgeted cycle → persist
 * provenance → refresh outcomes. Returns a compact result for the routine log.
 * Pure over the injected deps (no IO of its own).
 */
export async function runScoutTick(deps: ScoutTickDeps, opts: ScoutTickOptions = {}): Promise<ScoutTickResult> {
  const state = await deps.readCadenceState();
  const verdict = shouldRunScoutCycle(state, opts.cadence);
  if (!verdict.fire) {
    return { fired: false, reason: verdict.reason, retryAfterSec: verdict.retryAfterSec };
  }

  if (deps.fireGate) {
    const gate = await deps.fireGate();
    if (!gate.allow) {
      return { fired: false, reason: 'circuit', retryAfterSec: gate.retryAfterSec };
    }
  }

  const budget = resolveScoutBudget(opts.budget);
  const cycleId = (deps.newCycleId ?? ((n) => `scout-${n}`))(state.nowMs);
  await deps.recordFire?.('attempt');
  try {
    const cycle = await deps.runCycle({ budget, cycleId });
    const provenance = cycle.provenance ?? [];
    if (provenance.length > 0) await deps.persistRouted(provenance, cycleId);
    await deps.refreshOutcomes?.();
    await deps.recordFire?.('ok');
    return { fired: true, reason: verdict.reason, cycleId, routedCount: provenance.length };
  } catch (e) {
    await deps.recordFire?.('error');
    return { fired: false, reason: 'cycle-error', cycleId, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── production wiring ─────────────────────────────────────────────────────────

/** The autoloop role key for Scout-cycle fire-state (backoff/circuit + last-run). */
export const SCOUT_CYCLE_ROLE = 'scout-cycle';

export interface BuildScoutTickDepsOptions {
  harnessSlug: string;
  /** cb4b9's runScoutCycle, adapted to the budgeted-cycle shape. */
  runCycle: ScoutTickDeps['runCycle'];
  /** Fleet idle ratio in [0,1] (1 = idle). Injected so the scheduler stays decoupled from fleet internals. */
  readIdleRatio: () => Promise<number>;
  /** Recent unaddressed friction-signal count (e.g. open idea-queue backlog / watchdog signals). */
  readFrictionSignals: () => Promise<number>;
  workspaceId?: string;
  /** now() override (tests). */
  now?: () => number;
}

/**
 * Wire production {@link ScoutTickDeps}: cadence-state from the two injected fleet
 * signals + the autoloop last-fired clock; provenance + outcomes via the P-013
 * ledger; fire-gate + fire-recording via the autoloop (role {@link SCOUT_CYCLE_ROLE}).
 * The two fleet-specific readers stay injected (the codebase's pure-reader pattern).
 */
export function buildScoutTickDeps(opts: BuildScoutTickDepsOptions): ScoutTickDeps {
  const { harnessSlug } = opts;
  const now = opts.now ?? (() => Date.now());
  return {
    async readCadenceState(): Promise<ScoutCadenceState> {
      // Lazy import to keep this module's pure core free of the autoloop/PG edge.
      const { readFireState } = await import('../autoloop');
      const [idleRatio, frictionSignals, fire] = await Promise.all([
        opts.readIdleRatio().catch(() => 0),
        opts.readFrictionSignals().catch(() => 0),
        readFireState(harnessSlug, SCOUT_CYCLE_ROLE).catch(() => null),
      ]);
      return {
        idleRatio,
        frictionSignals,
        lastRunAtMs: fire?.lastFiredAt ? fire.lastFiredAt.getTime() : null,
        nowMs: now(),
      };
    },
    runCycle: opts.runCycle,
    async persistRouted(records, cycleId) {
      for (const r of records) {
        await recordRoutedIdea({
          ideaId: r.ideaId,
          lens: r.lens,
          rail: r.rail,
          routedRef: r.routedRef,
          harnessSlug,
          cycleId,
          title: r.title,
          addressesPatternRefs: r.addressesPatternRefs,
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        });
      }
    },
    async fireGate(): Promise<ScoutFireGate> {
      const { checkFireGate } = await import('../autoloop');
      const v = await checkFireGate(harnessSlug, SCOUT_CYCLE_ROLE);
      return { allow: v.allow, reason: v.reason, retryAfterSec: v.retryAfterSec };
    },
    async recordFire(outcome) {
      const { recordFire } = await import('../autoloop');
      await recordFire(harnessSlug, SCOUT_CYCLE_ROLE, SCOUT_CYCLE_ROLE, outcome);
    },
    async refreshOutcomes() {
      await refreshScoutOutcomes({ harnessSlug, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) });
    },
  };
}
