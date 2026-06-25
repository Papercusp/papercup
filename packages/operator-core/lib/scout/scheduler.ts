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
import { readIdeaQueueStatus } from './routed-ledger';
import { recordScoutTick, readLastRanTickAtMs, type ScoutTickRecord } from './tick-ledger';
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
  /** Ideas the ideators produced (ScoutCycleResult.ideas) — tick observability (P-034). */
  ideas?: readonly unknown[];
  /** Every idea after the critics (ScoutCycleResult.scored). */
  scored?: readonly unknown[];
  /** keep + moonshot after the critics (ScoutCycleResult.survivors) — deduped = scored − survivors. */
  survivors?: readonly unknown[];
  /** Why the cycle ended (ScoutCycleResult.stop). */
  stop?: string;
}

/**
 * One pending Queen→Scout revision request (queen-scout-feedback-loop-2026-06-20,
 * P-001/D-001). The scheduler reads these at cycle-start from coord:inbox addressed
 * to `scout:<hive>` ({@link ScoutTickDeps.readQueenFeedback}); each is a coord
 * message the Queen sent carrying the routed draft's `plan_slug` + her guidance
 * `body`. Their presence fires the cycle out-of-cadence (`queen-feedback`, P-002)
 * and is threaded into the cycle so it runs a TARGETED revision on those drafts.
 */
export interface QueenFeedbackItem {
  /** The routed DRAFT plan slug the Queen is giving feedback on. */
  planSlug: string;
  /** The Queen's guidance text (the coord message body). */
  body: string;
  /** The Queen's coord owner id (the message sender) — the ping-back recipient. */
  fromOwnerId: string;
  /** The coord msg_id (acked after the revision so it is consumed exactly once). */
  msgId: string;
  /** ISO timestamp the Queen sent it (ordering / observability). */
  ts: string;
}

export interface ScoutFireGate {
  allow: boolean;
  reason?: string;
  retryAfterSec?: number;
}

export interface ScoutTickDeps {
  /** Read live cadence signals (idle ratio, friction count, last-run epoch ms). */
  readCadenceState: () => Promise<ScoutCadenceState>;
  /** Run one Scout cycle under the resolved budget (cb4b9's runScoutCycle, adapted).
   *  When `queenFeedback` is present (the cycle-start coord:inbox read found
   *  plan-keyed Queen feedback, P-001) the runner targets a REVISION of those draft
   *  plans instead of fresh ideation; otherwise it ideates as usual. */
  runCycle: (ctx: {
    budget: Required<ScoutBudget>;
    cycleId: string;
    queenFeedback?: QueenFeedbackItem[];
    signal?: AbortSignal;
  }) => Promise<ScoutCycleLike>;
  /** Persist routed-idea provenance for the cycle (P-013 ledger). */
  persistRouted: (records: ScoutRoutedRecord[], cycleId: string) => Promise<void>;
  /** Optional autoloop fire-gate (backoff/circuit); default: always allow. */
  fireGate?: () => Promise<ScoutFireGate>;
  /** Optional fire-state recorder (autoloop recordFire). */
  recordFire?: (outcome: 'attempt' | 'ok' | 'error') => Promise<void>;
  /**
   * Optional single-flight claim (EI-304): atomically claim the fire slot
   * given the lastRunAtMs this tick READ. Returns false when a concurrent
   * tick (any process) already claimed since the read — the loser skips.
   */
  claimFire?: (expectedLastFiredAtMs: number | null) => Promise<boolean>;
  /** Optional: recompute + persist lens outcomes after the cycle (P-013). */
  refreshOutcomes?: () => Promise<void>;
  /**
   * Optional tick recorder (P-034 observability — `harness_shared.scout_ticks`).
   * Best-effort: runScoutTick swallows its errors, so recording never fails a tick.
   */
  recordTick?: (rec: ScoutTickRecord) => Promise<void>;
  /**
   * Read pending Queen→Scout revision requests at cycle-start (queen-scout-feedback-loop
   * P-001) — the coord:inbox messages addressed to `scout:<hive>` carrying a plan_slug
   * (the Queen's feedback on a routed draft). Best-effort by contract: runScoutTick
   * swallows its errors (a coord read must never fail a tick), and an unwired dep ⇒ the
   * feedback loop is dormant (the hermetic unit-test default). When it returns items the
   * tick fires `queen-feedback` out-of-cadence and threads them into {@link runCycle}.
   */
  readQueenFeedback?: () => Promise<QueenFeedbackItem[]>;
  /**
   * Acknowledge the consumed Queen feedback after a SUCCESSFUL revision cycle (P-001) so
   * the same message is not re-processed on the next tick (exactly-once). Best-effort —
   * an ack failure never fails the tick (the message simply re-fires next tick).
   */
  ackQueenFeedback?: (items: QueenFeedbackItem[]) => Promise<void>;
  /** Mint a cycle id; default `scout-<nowMs>`. */
  newCycleId?: (nowMs: number) => string;
}

export interface ScoutTickOptions {
  cadence?: ScoutCadenceOptions;
  budget?: ScoutBudget;
  /**
   * Hard wall-clock bound for the budgeted Scout cycle body. The DBOS routineFire
   * deadline is much longer than Scout's cadence; a hung LLM/gateway call must
   * record an error tick and release the routine dedup before that outer deadline.
   */
  cycleTimeoutMs?: number;
}

export interface ScoutTickResult {
  fired: boolean;
  /**
   * Cadence reason when fired/withheld, or a structural-gate refusal:
   * 'circuit' / 'claim-lost' / 'cycle-error', 'workspace-ceiling' (P-051 — the
   * workspace-wide scout spend ceiling refused this cycle BEFORE the tick), or
   * 'not-hive-runner' (P-019 — a SHARED-Hive node that is NOT the elected per-Hive
   * single runner stood down so only ONE node's scout loop fires across the Hive).
   */
  reason:
    | ScoutCadenceVerdict['reason']
    | 'circuit'
    | 'claim-lost'
    | 'cycle-error'
    | 'workspace-ceiling'
    | 'not-hive-runner';
  cycleId?: string;
  routedCount?: number;
  /** The fired cycle's reported LLM spend (cycle.costUsd) — FB-01 learning-governor ledgering. */
  costUsd?: number;
  retryAfterSec?: number;
  error?: string;
}

/**
 * One autonomous Scout tick: cadence-gate → fire-gate → budgeted cycle → persist
 * provenance → refresh outcomes. Returns a compact result for the routine log.
 * Pure over the injected deps (no IO of its own). Every exit also records one
 * `scout_ticks` row via the optional `recordTick` dep (P-034): which self-gate
 * withheld a no-op tick, or the generated/routed/deduped counts + spend of a
 * full cycle — best-effort (a recording failure never fails the tick).
 */
export async function runScoutTick(deps: ScoutTickDeps, opts: ScoutTickOptions = {}): Promise<ScoutTickResult> {
  // P-034 observability: one durable row per tick, naming the self-gate that
  // stopped a no-op or the counts of a full cycle. Best-effort by contract —
  // a recording failure must never fail the tick itself.
  const note = async (rec: ScoutTickRecord): Promise<void> => {
    try {
      await deps.recordTick?.(rec);
    } catch {
      /* best-effort — observability never fails the tick */
    }
  };

  // P-001: read pending Queen→Scout revision requests (coord:inbox → scout:<hive>)
  // BEFORE the cadence gate. Best-effort by contract — a coord read must never fail
  // a tick (an error / unwired dep ⇒ no feedback, the loop is simply dormant). When
  // present they fire the cycle OUT-OF-CADENCE (queen-feedback) past the floor and are
  // threaded into runCycle so it targets a revision of those drafts (P-002 / D-001).
  let queenFeedback: QueenFeedbackItem[] = [];
  if (deps.readQueenFeedback) {
    try {
      queenFeedback = (await deps.readQueenFeedback()) ?? [];
    } catch {
      /* best-effort — a coord read never fails the tick */
    }
  }

  const baseState = await deps.readCadenceState();
  // Overlay the queen-feedback signal onto the cadence state (readCadenceState owns
  // the fleet/ledger signals; the Queen-feedback channel is the scheduler's, so the
  // flag is merged here rather than coupling the cadence reader to coord).
  const state: ScoutCadenceState =
    queenFeedback.length > 0 ? { ...baseState, queenWakePending: true } : baseState;
  const verdict = shouldRunScoutCycle(state, opts.cadence);
  if (!verdict.fire) {
    await note({
      status: 'gated',
      gate: verdict.reason,
      ...(verdict.retryAfterSec != null ? { detail: { retryAfterSec: verdict.retryAfterSec } } : {}),
    });
    return { fired: false, reason: verdict.reason, retryAfterSec: verdict.retryAfterSec };
  }

  if (deps.fireGate) {
    const gate = await deps.fireGate();
    if (!gate.allow) {
      await note({
        status: 'gated',
        gate: 'circuit',
        detail: {
          ...(gate.reason ? { reason: gate.reason } : {}),
          ...(gate.retryAfterSec != null ? { retryAfterSec: gate.retryAfterSec } : {}),
        },
      });
      return { fired: false, reason: 'circuit', retryAfterSec: gate.retryAfterSec };
    }
  }

  // EI-304 single-flight: everything above is check-then-act — two overlapping
  // ticks both snapshot stale cadence state and both pass the floor. The claim
  // is the one atomic step that collapses them to a single cycle; the loser
  // exits as a gated no-op.
  if (deps.claimFire) {
    // EI-1600: the single-flight claim CAS's against the autoloop FIRE-SLOT clock
    // (autoloop_state.last_fired_at), which is NOT the cadence clock (lastRunAtMs =
    // last RUN). Use fireSlotLastMs when the production wiring supplies it; fall
    // back to lastRunAtMs for the unit-test fakes that model a single shared clock.
    const claimExpected =
      state.fireSlotLastMs !== undefined ? state.fireSlotLastMs : state.lastRunAtMs;
    const claimed = await deps.claimFire(claimExpected ?? null);
    if (!claimed) {
      await note({ status: 'gated', gate: 'claim-lost' });
      return { fired: false, reason: 'claim-lost' };
    }
  }

  const budget = resolveScoutBudget(opts.budget);
  const cycleId = (deps.newCycleId ?? ((n) => `scout-${n}`))(state.nowMs);
  await deps.recordFire?.('attempt');
  try {
    const cycle = await withScoutCycleTimeout(
      (signal) => deps.runCycle({
        budget,
        cycleId,
        ...(queenFeedback.length > 0 ? { queenFeedback } : {}),
        signal,
      }),
      opts.cycleTimeoutMs ?? scoutCycleTimeoutMs(),
    );
    const provenance = cycle.provenance ?? [];
    if (provenance.length > 0) await deps.persistRouted(provenance, cycleId);
    await deps.refreshOutcomes?.();
    // P-001: a queen-feedback revision cycle SUCCEEDED — ack the consumed messages
    // so the same feedback is not re-processed next tick (exactly-once). Best-effort:
    // an ack failure simply leaves the message to re-fire, it never fails the tick.
    if (queenFeedback.length > 0 && deps.ackQueenFeedback) {
      try {
        await deps.ackQueenFeedback(queenFeedback);
      } catch {
        /* best-effort — re-fires next tick rather than failing this one */
      }
    }
    await deps.recordFire?.('ok');
    await note({
      status: 'ran',
      ideasGenerated: cycle.ideas?.length ?? 0,
      ideasRouted: provenance.length,
      ideasDeduped:
        cycle.scored && cycle.survivors ? Math.max(0, cycle.scored.length - cycle.survivors.length) : 0,
      ...(cycle.costUsd != null ? { budgetUsedUsd: cycle.costUsd } : {}),
      detail: {
        cycleId,
        reason: verdict.reason,
        ...(cycle.stop ? { stop: cycle.stop } : {}),
        ...(queenFeedback.length > 0 ? { queenFeedbackCount: queenFeedback.length } : {}),
      },
    });
    return {
      fired: true,
      reason: verdict.reason,
      cycleId,
      routedCount: provenance.length,
      ...(cycle.costUsd != null ? { costUsd: cycle.costUsd } : {}),
    };
  } catch (e) {
    await deps.recordFire?.('error');
    const error = e instanceof Error ? e.message : String(e);
    await note({ status: 'error', detail: { cycleId, error } });
    return { fired: false, reason: 'cycle-error', cycleId, error };
  }
}

export const DEFAULT_SCOUT_CYCLE_TIMEOUT_MS = 20 * 60_000;

function scoutCycleTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_SCOUT_CYCLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SCOUT_CYCLE_TIMEOUT_MS;
}

async function withScoutCycleTimeout<T>(run: (signal?: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run(ctrl.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort();
          reject(new Error(`Scout cycle timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── production wiring ─────────────────────────────────────────────────────────

/** The autoloop role key for Scout-cycle fire-state (backoff/circuit + last-run). */
export const SCOUT_CYCLE_ROLE = 'scout-cycle';

/** Max Queen-feedback messages a single tick processes (P-001) — a safety bound so a
 *  backlog can't fan out one giant revision tick; the remainder re-fire next tick. */
export const MAX_QUEEN_FEEDBACK_PER_TICK = 20;

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
      // Lazy import to keep this module's pure core free of the autoloop/PG/flag edge.
      const { readFireState } = await import('../autoloop');
      // K1 workspace-brain scope (workspace-scoped-coordination-2026-06-20 D-006/P-002):
      // when WORKSPACE_COORDINATION is ON, the workspace-Scout is ONE brain over the
      // whole workspace, so the idea-pipeline drain signal (the `ideas-drained` trigger)
      // must span ALL the workspace's routed ideas, not just this install's — otherwise
      // a single hive draining would wrongly re-trigger the workspace brain. OFF ⇒
      // per-install, byte-identical to today. Best-effort flag read (defaults OFF on error).
      const { isWorkspaceCoordinationOn, workspaceBrainReadKeys } = await import('../workspace-brain-scope');
      const wsCoordOn = await isWorkspaceCoordinationOn();
      // EI-1600: the cadence floor (min-interval / heartbeat) is measured from the
      // last cycle that ACTUALLY RAN (scout_ticks status='ran'/'fired'), NOT the
      // autoloop fire-ATTEMPT clock — a hung/errored fire advances last_fired_at
      // without running a cycle, and measuring the floor from it gates every
      // subsequent tick as min-interval (the ~24h Scout dormancy). The autoloop
      // last_fired_at is still read, but only as the FIRE-SLOT clock for the
      // single-flight claimFire CAS (fireSlotLastMs). The ran-tick read reconciles
      // across the workspace-brain re-key (K1) with the same read-fallback keys the
      // routed-ledger uses, so a sentinel/legacy install_slug split still resolves
      // the true last run.
      const ranReadKeys = opts.workspaceId
        ? workspaceBrainReadKeys(opts.workspaceId, harnessSlug, wsCoordOn)
        : [harnessSlug];
      const [idleRatio, frictionSignals, fire, ideaQueue, lastRanAtMs] = await Promise.all([
        opts.readIdleRatio().catch(() => 0),
        opts.readFrictionSignals().catch(() => 0),
        readFireState(harnessSlug, SCOUT_CYCLE_ROLE).catch(() => null),
        // Idea-pipeline status powers the `ideas-drained` trigger (owner-set
        // 2026-06-18). Best-effort: a read failure falls back to total 0, which
        // disables the drain trigger for that tick (heartbeat still fires). Under
        // WORKSPACE_COORDINATION the harness filter is dropped → the workspace-wide
        // drain signal (one brain sees the whole pipeline).
        readIdeaQueueStatus({
          ...(wsCoordOn ? {} : { harnessSlug }),
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        }).catch(() => ({ total: 0, pending: 0 })),
        // The cadence clock (EI-1600). Best-effort: a read failure ⇒ null = "never
        // ran", which fires idle/heartbeat freely rather than wedging the loop.
        readLastRanTickAtMs({
          installSlugs: ranReadKeys,
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        }).catch(() => null),
      ]);
      return {
        idleRatio,
        frictionSignals,
        // Cadence floor = last RUN (scout_ticks), NOT the autoloop attempt clock.
        lastRunAtMs: lastRanAtMs,
        // Fire-slot clock for the single-flight claimFire CAS only (autoloop).
        fireSlotLastMs: fire?.lastFiredAt ? fire.lastFiredAt.getTime() : null,
        nowMs: now(),
        routedIdeaTotal: ideaQueue.total,
        pendingIdeaCount: ideaQueue.pending,
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
    async claimFire(expectedLastFiredAtMs) {
      const { claimFire } = await import('../autoloop');
      return claimFire(harnessSlug, SCOUT_CYCLE_ROLE, expectedLastFiredAtMs, 'scout-claim');
    },
    async refreshOutcomes() {
      await refreshScoutOutcomes({ harnessSlug, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) });
    },
    async readQueenFeedback(): Promise<QueenFeedbackItem[]> {
      // P-001: the Queen→Scout feedback channel — coord:inbox messages addressed
      // DIRECTLY to `scout:<hive>` (not broadcasts) carrying a routed draft's
      // plan_slug. Dedup against the Scout's own acks (readAckedMsgIds) so a
      // message is processed exactly once across ticks. Coord I/O runs in the
      // routine's workspace ALS (the event log is workspace-keyed). Lazy imports
      // keep this module's pure core free of the coord/PG edge.
      const { scoutCoordOwnerId } = await import('./coord-identity');
      const { readInbox, readAckedMsgIds } = await import('../agent-tools/coordination/messages');
      const { runWithWorkspace } = await import('../workspace-als');
      const scoutOwner = scoutCoordOwnerId(harnessSlug);
      const gather = async (): Promise<QueenFeedbackItem[]> => {
        const [inbox, acked] = await Promise.all([readInbox(scoutOwner, {}), readAckedMsgIds(scoutOwner)]);
        return inbox
          .filter((e) => e.kind !== 'ack') // never treat an ack as feedback
          .filter((e) => !e.category) // drop ambient (service-health / governor), like coord:inbox
          .filter((e) => Array.isArray(e.to) && e.to.includes(scoutOwner)) // DIRECTED, not a '*' broadcast
          .filter((e) => typeof e.plan_slug === 'string' && (e.plan_slug as string).length > 0) // plan-keyed
          .filter((e) => !acked.has(e.msg_id)) // not yet consumed
          .map(
            (e): QueenFeedbackItem => ({
              planSlug: e.plan_slug as string,
              body: ((e.body ?? e.summary ?? '') as string).trim(),
              fromOwnerId: e.from,
              msgId: e.msg_id,
              ts: e.ts,
            }),
          )
          .slice(-MAX_QUEEN_FEEDBACK_PER_TICK); // bound a backlog; the rest re-fire next tick
      };
      return opts.workspaceId ? runWithWorkspace(opts.workspaceId, gather) : gather();
    },
    async ackQueenFeedback(items: QueenFeedbackItem[]): Promise<void> {
      if (items.length === 0) return;
      const { scoutCoordOwnerId } = await import('./coord-identity');
      const { appendAck } = await import('../agent-tools/coordination/messages');
      const { runWithWorkspace } = await import('../workspace-als');
      const scoutOwner = scoutCoordOwnerId(harnessSlug);
      const identity = {
        ownerId: scoutOwner,
        ownerLabel: `scout · ${harnessSlug}`,
        source: 'principal' as const,
        workspaceId: opts.workspaceId ?? null,
        userId: null,
      };
      const ack = async (): Promise<void> => {
        for (const it of items) await appendAck(identity, it.msgId, it.fromOwnerId);
      };
      await (opts.workspaceId ? runWithWorkspace(opts.workspaceId, ack) : ack());
    },
    async recordTick(rec) {
      // K1 workspace-brain scope (workspace-scoped-coordination-2026-06-20 D-006/P-002):
      // when WORKSPACE_COORDINATION is ON, the workspace-Scout's tick observability rolls
      // up under the workspace sentinel (install_slug = workspaceId) — ONE coherent tick
      // stream per workspace brain, the same sentinel keying the lens-weights already use
      // (routed-ledger.refreshScoutOutcomes). OFF ⇒ the per-install slug, byte-identical
      // to today. The sentinel needs a workspaceId; without one we keep the per-install
      // slug (the dark/legacy path). Best-effort flag read (defaults OFF on error).
      const { isWorkspaceCoordinationOn, workspaceBrainScopeKey } = await import('../workspace-brain-scope');
      const installSlug = opts.workspaceId
        ? workspaceBrainScopeKey(opts.workspaceId, harnessSlug, await isWorkspaceCoordinationOn())
        : harnessSlug;
      await recordScoutTick({
        ...rec,
        installSlug,
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      });
    },
  };
}
