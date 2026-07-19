/**
 * liveness-alarm — the REQUEST-PATH supervision alarm
 * (infra-self-healing-supervision-2026-06-19, R4-3 + R4-8).
 *
 * `computeSystemHealth` (compute.ts) already aggregates 15 panels — dead routines,
 * queen/overwatch liveness, git-sync staleness, PG, the LLM account pool — and
 * `runSystemHealthTick` keeps a per-workspace cache warm. EI-1622 moved that
 * tick out of DBOS and into the in-process periodic scheduler, so it no longer
 * writes workflow_status rows; this request-path alarm remains as the independent
 * watcher for bg-host down / BACKGROUND_WORKERS=0 regressions and stale snapshots.
 *
 * This alarm runs on a :3070 REQUEST worker loop (in cluster mode the workers are
 * request-only, structurally separate from the bg primary; single-process degrades
 * cleanly), and on a degraded TRANSITION fires an out-of-band owner escalation.
 * Two independent liveness sources:
 *   1. the rollup's own CRITICAL panels (dead routines, queen dark, accounts
 *      starved, any panel self-reporting `crit`); and
 *   2. a STALE shared DBOS `routinesTick` watermark — this is the authoritative
 *      cross-process heartbeat for the separate bg host. The request worker's
 *      `lastSystemHealth` cache is process-local and therefore cannot prove bg-host
 *      liveness (WI-4773). This signal needs NO live engine to detect a dead engine.
 *
 * Transition-only + per-signal debounced so it never spams; env-killable
 * (PAPERCUSP_INFRA_LIVENESS_ALARM=0). The watcher does not live in what it watches.
 *
 * EI-2146 — dedup + auto-resolve (detector-failure fix). The per-signal
 * `lastAlertedAt` debounce is in-memory, so it is per-WORKER and per-PROCESS: in
 * cluster mode (N request workers) and across restarts it does NOT dedup, so one
 * ~4h incident left dozens of identical never-closing `blocker` escalations that
 * drowned real signal and grew coord_event_log unbounded. The durable fix keys
 * off the escalation LOG itself (a stable per-signal signature):
 *   1. DEDUP — never open a second escalation while one with the same signature
 *      is still open (collapse repeats into one row; re-fire only after recovery).
 *   2. AUTO-RESOLVE-ON-RECOVERY — each tick, resolve every open infra-liveness
 *      escalation whose condition is no longer firing. On the first post-deploy
 *      tick this is the one-time backlog sweep of the recovered cohort.
 *   3. FALSE-POSITIVE SUPPRESSION — "no bees running" is NOT a fault when the
 *      placement frontier is genuinely empty (an idle fleet is correct).
 *
 * EI-9939 — flap-episode suppression (the fleet-wide re-broadcast TAX fix).
 * EI-2146's own "re-fire only after auto-resolve" design is CORRECT for a
 * genuine second incident but, for a condition that FLAPS (fires, recovers,
 * re-fires — e.g. the routine-engine-starvation flap observed 2026-07-11/12,
 * repeat_count up to 31 in one session), it meant every flap cycle re-sent a
 * fleet-wide `page()` alarm + `pageResolved()` all-clear to `to:['*']` — pure
 * context tax on every live + parked session, none of whom own the flapping
 * routine. `flapEpisodes` below tracks each blocker signature's fire count
 * within a rolling window (default 30min, `DEFAULT_FLAP_THRESHOLD`=2): the
 * first two fires page normally (byte-identical to pre-EI-9939 behavior); the
 * 3rd+ fire in the same window is classified as flapping and its broadcast is
 * suppressed (the durable escalation row is written regardless — this only
 * gates the fleet-wide push). A suppressed episode gets exactly ONE final
 * all-clear once it stays quiet for a full flap window with no re-fire (the
 * "settle sweep"), which supersedes every earlier alert sharing that
 * condition_key via coord:inbox's `annotateResolvedConditions` — so a reader
 * who only saw the FIRST fire still learns it eventually cleared. A single
 * SUSTAINED incident (fires once, stays open) never enters flap tracking at
 * all and is completely unaffected. The routine-engine flapping ITSELF (why
 * dead-routines keeps firing/recovering) remains its own, separate open bug —
 * this only stops the ALARM SYSTEM from amplifying it into a broadcast storm.
 */
import { PANEL_LABELS, type SystemHealth, type PanelKey } from './types';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { computeSystemHealth, lastSystemHealth } from './compute';
import {
  openEscalation,
  listEscalationsPaginated,
  resolveEscalation,
  type EscalationSeverity,
  type EscalationRecord,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { activeWorkspaceId } from '../workspace-registry';
import { notifyAttention } from '../attention-notify';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../severe-event-broadcast';
import { resolveSevereEventOwner } from '../severe-event-owner';
import { currentLoopLag } from '../event-loop-lag-monitor';
import {
  readRoutineEngineLiveness as readSharedRoutineEngineLiveness,
  type RoutineEngineLiveness,
} from '../release/routine-engine-liveness';

export const INFRA_LIVENESS_IDENTITY: AgentIdentity = {
  ownerId: 'system:infra-liveness-alarm',
  ownerLabel: 'system · infra-liveness-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** A live supervision problem worth an out-of-band owner alert. */
export type HealthTickStallCause =
  | 'pg-pool-starvation'
  | 'event-loop-pressure'
  | 'routine-engine-stall'
  | 'background-worker-unavailable'
  | 'unattributed-stale-tick';

/** Durable evidence attached to a stale health-tick signal. */
export interface HealthTickStallDiagnosis {
  cause: HealthTickStallCause;
  evidence: string[];
  snapshotAgeMs: number;
  lastSnapshotAtMs: number | null;
  observedAtMs: number;
}

export interface AlarmSignal {
  key: string;
  severity: EscalationSeverity;
  summary: string;
  diagnosis?: HealthTickStallDiagnosis;
}

const DEFAULT_SNAPSHOT_STALE_MS = 6 * 60_000;
const DEFAULT_DEBOUNCE_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 2 * 60_000;
/** 6h since the last wake before an enabled-but-STOPPED overwatch fires
 *  `rubric-emission-dark` — generous vs any deliberate short pause. */
const RUBRIC_EMISSION_DARK_GRACE_MS = 6 * 60 * 60_000;

/**
 * EI-9794 — Kettle silently stopped firing for ~11h while `last_status` stayed
 * 'ok' and `consecutive_errors` stayed 0 (both are only WRITTEN on a fire, so a
 * loop that stops firing entirely freezes them at their last-good values
 * forever — green status is not proof of life). The existing signals #4/#4b/#4c
 * above all gate on `overwatchAlive` / `panels.overwatch.data.started`, which
 * derive from the `overwatch-wake` ROUTINE row's `armed` bit (cross-monitor.ts
 * `isDark`) — but that routine is a self-deactivating ONE-SHOT whose NORMAL
 * resting state between fires is `active=false, next_fire_at=NULL`, identical
 * to a fire that failed to re-arm. `harness_shared.autoloop_state.last_fired_at`
 * (stamped by `recordFire` on every ACTUAL fire, independent of the routine's
 * own re-arm bookkeeping) is the one signal that can't be spoofed by a
 * mid-re-arm crash — this alarm keys on ITS recency instead.
 */
export interface AutoloopFireRow {
  role: string;
  harnessSlug: string;
  /** epoch ms of `autoloop_state.last_fired_at`, or null if it has never fired. */
  lastFiredAtMs: number | null;
  cadenceSec: number;
  /** Is this role SUPPOSED to be actively firing right now (flag on + started)?
   *  false ⇒ vacuously fine, never alarm (mirrors cross-monitor.ts's `isDark`
   *  philosophy — a role that isn't running has nothing to be stale about). */
  expected: boolean;
}

/** How many cadences of silence before a fire-staleness alarm fires (env-tunable,
 *  matches the item's own suggested "N=3" — generous vs one missed/backed-off
 *  tick, sharp enough to catch an hours-long stall fast). */
function autoloopFireStaleMultiplier(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_FIRE_STALE_MULTIPLIER ?? 3);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/**
 * Attribute a stale system-health snapshot from the evidence available to the
 * request-path observer. This is deliberately conservative: a stale snapshot
 * alone proves a missed health tick, not its mechanism. Pool/loop evidence wins
 * over downstream dead-routine symptoms; when no corroborating signal exists we
 * say so explicitly instead of repeating the old unqualified "likely frozen".
 */
export function diagnoseHealthTickStall(
  health: SystemHealth,
  snapshotAgeMs: number,
  observedAtMs: number,
  lastSnapshotAtMs: number | null,
): HealthTickStallDiagnosis {
  const evidence: string[] = [];
  const infra = health.panels.infra?.data as
    | {
        pg?: { total?: number; active?: number } | null;
        pool?: { probeMs?: number; band?: string } | null;
        perf?: { status?: string; stale?: boolean; eventLoopLagP95Ms?: number | null; reasons?: string[] } | null;
      }
    | null
    | undefined;
  const workFeed = health.panels.workFeed?.data as
    | { deadRoutines?: number; deadRoutineNames?: string[] }
    | null
    | undefined;
  const loop = currentLoopLag();

  if (infra?.pool?.band === 'critical') {
    evidence.push(`pg acquire probe ${infra.pool.probeMs ?? '?'}ms (critical)`);
  }
  if (loop && Number.isFinite(loop.p95Ms) && loop.p95Ms >= 600) {
    evidence.push(`event-loop p95 ${Math.round(loop.p95Ms)}ms (critical)`);
  }
  if (infra?.perf && !infra.perf.stale && infra.perf.eventLoopLagP95Ms != null && infra.perf.eventLoopLagP95Ms >= 1000) {
    evidence.push(`captured event-loop p95 ${Math.round(infra.perf.eventLoopLagP95Ms)}ms (critical)`);
  }
  if ((workFeed?.deadRoutines ?? 0) > 0) {
    const names = workFeed?.deadRoutineNames?.slice(0, 3).join(', ');
    evidence.push(`${workFeed?.deadRoutines} overdue routine(s)${names ? `: ${names}` : ''}`);
  }
  if (infra?.pg === null) evidence.push('request-path PG read failed');

  const cause: HealthTickStallCause =
    infra?.pool?.band === 'critical'
      ? 'pg-pool-starvation'
      : loop && loop.p95Ms >= 600
        ? 'event-loop-pressure'
        : infra?.perf && !infra.perf.stale && infra.perf.eventLoopLagP95Ms != null && infra.perf.eventLoopLagP95Ms >= 1000
          ? 'event-loop-pressure'
          : (workFeed?.deadRoutines ?? 0) > 0
            ? 'routine-engine-stall'
            : infra?.pg === null
              ? 'background-worker-unavailable'
              : 'unattributed-stale-tick';

  if (evidence.length === 0) evidence.push('no corroborating pool, loop, routine, or PG evidence was readable');
  return { cause, evidence, snapshotAgeMs, lastSnapshotAtMs, observedAtMs };
}

/**
 * EI-15006 — the gating context for the `panel:bees` "no bees running" signal.
 *
 * A raw `bees.running === 0` is NOT by itself a fault: an idle-by-design pot (no
 * cup-placeable work + healthy capacity + other agents alive) legitimately runs
 * zero cups. The old gate suppressed the false positive ONLY when the raw survey
 * `frontier` was exactly 0 — but the survey frontier can carry non-cup / su-domain
 * / long-stuck residue (or read 0 while the spawner is genuinely DOWN), so it both
 * (a) FALSE-fired a blocker→human page during normal idle (the incident: frontier
 * 6, all su-domain, 9 su agents alive, dispatchBudget 20) AND (b) FALSE-suppressed
 * a genuine spawner-down when the frontier happened to be empty. This context lets
 * the predicate distinguish the three cases the alarm must get right.
 */
export interface BeesLivenessContext {
  /** Admissible cup-placeable frontier being left UNPLACED — the pot's FRESH,
   *  non-stuck placeable feature-family frontier (`frontier - frontierStuck`,
   *  the same "placeable" definition reconcilePausedQueen/queenPlacementStalled
   *  use). >0 means real cup work is waiting while 0 bees run ⇒ genuine starvation. */
  cupPlaceableFrontier: number;
  /** Live bee-tier dispatch budget (spare cup-tier admission slots) from the
   *  gateway capacity oracle. null = unknown (gateway off/unreachable) — treated
   *  fail-safe (never forces a page on its own; see `beesIdleByDesign`). */
  dispatchBudget: number | null;
  /** The gateway is inside its fresh-restart recovery window — capacity reads are
   *  unreliable, so 0 bees during it is not proof of a healthy idle. */
  restartRecovering: boolean;
  /** Any OTHER agent is alive (su fleet / other bees / the Mug loop). If so the
   *  spawn+inference engine is demonstrably working, so 0 bees is a placement
   *  DECISION, not an infra outage. false ⇒ the spawner cannot be proven live. */
  otherAgentsAlive: boolean;
}

/**
 * PURE: is `bees.running === 0` the correct IDLE-BY-DESIGN state (⇒ informational,
 * NO blocker→human page)? True only when ALL hold:
 *   - no admissible cup-placeable frontier is being left unplaced, AND
 *   - the gateway is not mid-restart, AND
 *   - some other agent is alive (the spawner/engine is provably live), AND
 *   - capacity is not KNOWN-exhausted (dispatchBudget, when readable, is > 0).
 *
 * Any other shape ⇒ NOT idle-by-design ⇒ the signal fires: real cup work waiting
 * (starvation), or the spawner is not provably live (down / recovering / no other
 * agent alive), or the cup tier is known-full while zero bees run (a leaked/stuck
 * slot). `dispatchBudget === null` (gateway off/unreachable) is deliberately
 * fail-safe — it does NOT by itself force a page, because a pot with the gateway
 * disabled must still be able to sit idle; the other-agents-alive proof carries it.
 */
export function beesIdleByDesign(ctx: BeesLivenessContext): boolean {
  if (ctx.cupPlaceableFrontier > 0) return false; // real cup work unplaced → starvation, not idle
  if (ctx.restartRecovering) return false; // gateway restarting → capacity unproven
  if (!ctx.otherAgentsAlive) return false; // spawner/engine not provably live
  if (ctx.dispatchBudget !== null && ctx.dispatchBudget <= 0) return false; // cup tier KNOWN-full while 0 bees run → anomaly
  return true; // 0 bees, no cup work, engine alive, capacity not known-exhausted → correct idle
}

/**
 * PURE: derive the non-capacity legs of {@link BeesLivenessContext} from a health
 * snapshot, folding in the gateway-sourced capacity legs. Kept pure (capacity is
 * injected) so the whole gate is unit-testable without I/O.
 */
export function beesLivenessFromHealth(
  health: SystemHealth,
  capacity: { dispatchBudget: number | null; restartRecovering: boolean },
): BeesLivenessContext {
  const wf = health.panels.workFeed?.data;
  const frontier = wf?.frontier ?? 0;
  const frontierStuck = wf?.frontierStuck ?? 0;
  const cupPlaceableFrontier = Math.max(0, frontier - frontierStuck);
  const suLive = health.panels.suFleet?.data?.live ?? 0;
  const beesAlive = health.panels.bees?.data?.alive ?? 0;
  const queenAlive = health.crossMonitor?.queenAlive === true;
  return {
    cupPlaceableFrontier,
    dispatchBudget: capacity.dispatchBudget,
    restartRecovering: capacity.restartRecovering,
    otherAgentsAlive: suLive > 0 || beesAlive > 0 || queenAlive,
  };
}

/**
 * Fetch the cup(bee)-tier dispatch budget + fresh-restart flag from the gateway
 * capacity oracle (the SAME `buildCapacityReport` the Mug's placement clamp reads,
 * so this can never disagree with what placement sees). Fail-soft: any error /
 * gateway-off ⇒ `{ dispatchBudget: null, restartRecovering: false }` (unknown —
 * `beesIdleByDesign` then relies on the other-agents-alive proof).
 */
async function readGatewayBeeCapacity(): Promise<{ dispatchBudget: number | null; restartRecovering: boolean }> {
  try {
    const [{ fetchGatewayHeadroom }, { buildCapacityReport }] = await Promise.all([
      import('../inference-gateway/observability'),
      import('../fleet/capacity-dispatch'),
    ]);
    const hr = await fetchGatewayHeadroom({ timeoutMs: 1200 });
    const report = buildCapacityReport(hr, { clampArmed: false });
    return { dispatchBudget: report.dispatchBudget, restartRecovering: report.restartRecovering };
  } catch {
    return { dispatchBudget: null, restartRecovering: false };
  }
}

/**
 * Build the full {@link BeesLivenessContext} for a health snapshot: the pure
 * snapshot legs + a live gateway-capacity fetch. Used by BOTH the source alarm
 * (`runLivenessAlarmTick`) AND the condition-staleness RECONCILER
 * (`defaultReadInfraLivenessHealth`) so the two can never drift on whether the
 * `panel:bees` signal is firing. Fail-soft (never throws).
 */
export async function readBeesLivenessContext(health: SystemHealth): Promise<BeesLivenessContext> {
  const capacity = await readGatewayBeeCapacity();
  return beesLivenessFromHealth(health, capacity);
}

/**
 * PURE: derive the critical supervision signals from a SystemHealth snapshot.
 * `snapshotAgeMs` is the age of `lastSystemHealth` at evaluation (null = the
 * snapshot was computed fresh this tick, so staleness is not a signal).
 */
export function evaluateLivenessAlarm(
  health: SystemHealth,
  snapshotAgeMs: number | null,
  opts: {
    snapshotStaleMs?: number;
    prevPostmasterStartMs?: number | null;
    /** EI-9794: fresh `autoloop_state` fire-recency rows (see the type doc above).
     *  Optional — omitted/empty means "not evaluated this tick" (fail-open, never
     *  a false negative from a caller that hasn't wired the fetch). */
    autoloopFireRows?: AutoloopFireRow[];
    /** EI-11841: typed evidence for a stale health tick, computed by the request-path
     *  caller while the last successful snapshot is still available. */
    stallDiagnosis?: HealthTickStallDiagnosis;
    /** EI-15006: cup-placeable-frontier + capacity gating for the `panel:bees`
     *  "no bees running" signal. Omitted ⇒ the LEGACY EI-2146 gate (suppress only
     *  when the raw survey frontier is 0) — kept so an old/pure caller never
     *  regresses; the live source + reconciler always thread this. */
    beesLiveness?: BeesLivenessContext;
  } = {},
): AlarmSignal[] {
  const staleMs = opts.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
  // EI-1695: a stale snapshot means the bg routine engine is frozen — the SAME
  // condition that blinds the in-engine account-state read into a false
  // all-paused 'accounts-starved'. Compute it once so that derived signal can be
  // folded into the one root-cause (health-tick-stale) blocker below instead of
  // firing N separate rate-starvation blockers for one incident.
  const tickStale = snapshotAgeMs !== null && snapshotAgeMs > staleMs;
  const signals: AlarmSignal[] = [];

  // 1. The bg health-tick itself stalled → the routine engine (and the watchdog
  //    that lives in it) is likely frozen. The request-path catch for the
  //    BACKGROUND_WORKERS=0 / bg-host-down class.
  if (tickStale) {
    const diagnosis = opts.stallDiagnosis;
    const detail = diagnosis
      ? ` Root cause: ${diagnosis.cause}; evidence: ${diagnosis.evidence.join('; ')}; last successful tick ${diagnosis.lastSnapshotAtMs === null ? 'unknown' : new Date(diagnosis.lastSnapshotAtMs).toISOString()}; observed ${new Date(diagnosis.observedAtMs).toISOString()}.`
      : '';
    signals.push({
      key: 'health-tick-stale',
      severity: 'blocker',
      summary: `system-health tick stale for ${Math.round(snapshotAgeMs / 60_000)}m — the background routine engine (DBOS) may be frozen; routines / git-sync / Mug may be stalled and the in-engine watchdog may be blind.${detail}`,
      ...(diagnosis ? { diagnosis } : {}),
    });
  }

  // 2. Dead routines — active cron routines long overdue (the routine engine is
  //    starved/frozen). Sharper than the stale-snapshot signal when the tick lives.
  const wf = health.panels.workFeed?.data;
  if (wf && wf.deadRoutines > 0) {
    const names = wf.deadRoutineNames?.length ? `: ${wf.deadRoutineNames.slice(0, 4).join(', ')}` : '';
    signals.push({
      key: 'dead-routines',
      severity: 'blocker',
      summary: `${wf.deadRoutines} dead routine(s) overdue >10m${names} — the routine engine is starved.`,
    });
  }

  // 3. Queen loop dark — LIVENESS (started but no live wake), distinct from a
  //    chosen pause.
  if (health.crossMonitor?.queenAlive === false && health.panels.queen?.data?.started) {
    signals.push({
      key: 'queen-dark',
      severity: 'blocker',
      summary: `Mug loop dark (started, no live wake) — ${health.panels.queen?.summary ?? ''}`.trim(),
    });
  }

  // 4. Overwatch dark — only when it is supposed to be running.
  if (health.crossMonitor?.overwatchAlive === false && health.panels.overwatch?.data?.started) {
    signals.push({
      key: 'overwatch-dark',
      severity: 'advisory',
      summary: `Kettle supervisor loop dark — ${health.panels.overwatch?.summary ?? ''}`.trim(),
    });
  }

  // 4b. Overwatch ALIVE but SKIPPING its mandated scorecard (monitor-the-monitor,
  //     hive-loop-supervision 2026-06-21). overwatch-dark catches a NON-waking
  //     supervisor; this catches the OTHER failure — it wakes (autoloop 'ok') yet
  //     silently omits the Owner-#1 every-wake pot-coordination-health scorecard, so
  //     the health-trend goes blind while everything LOOKS alive. The settled-wake grace
  //     lives in compute.ts (the `scorecardSkipped` flag) so this stays pure.
  const ow = health.panels.overwatch?.data;
  if (ow?.started && ow.scorecardSkipped) {
    const e = ow.scorecardEmission;
    signals.push({
      key: 'overwatch-scorecard-skipped',
      severity: 'advisory',
      summary:
        e?.status === 'partial-only'
          ? `Kettle emitting only PARTIAL pot-coordination-health scorecards since its last wake (${e.missingCount} criteria unrated) — Owner #1 mandate (a COMPLETE scorecard EVERY wake) truncated.`
          : `Kettle woke but emitted NO complete pot-coordination-health scorecard since its last wake — Owner #1 mandate (a scorecard EVERY wake) skipped; the health-trend is going blind.`,
    });
  }

  // 4c. Rubric emission dark — flag ON but the supervisor is STOPPED, long past a
  //     wake. 4/4b both gate on `started`, and the freshness interpreter reads
  //     'not-started' as benign — so a monitor stopped mid-flight went silent
  //     FOREVER (WI-2374: emission died with overwatch on 2026-07-02 and nothing
  //     noticed). Fires only when it HAS woken before (lastWakeAt != null — a
  //     never-started fresh install stays quiet) and after a 6h grace. Auto-resolves
  //     when overwatch restarts OR the flag is turned off (making the pause explicit).
  if (ow?.flagEnabled && !ow.started && ow.lastWakeAt != null) {
    const darkMs = health.evaluatedAt - ow.lastWakeAt;
    if (darkMs > RUBRIC_EMISSION_DARK_GRACE_MS) {
      signals.push({
        key: 'rubric-emission-dark',
        severity: 'advisory',
        summary:
          `pot-coordination-health AGENT emission dark ${Math.round(darkMs / 3_600_000)}h — overwatch is enabled but STOPPED ` +
          `(last wake ${new Date(ow.lastWakeAt).toISOString()}). The scheduled pulse keeps a deterministic floor, but the ` +
          `agent trend is blind. kettle:start to resume, or turn the papercusp-overwatch flag OFF to make the pause explicit.`,
      });
    }
  }

  // 5. LLM substrate starved — every pool account paused. ONLY trusted when the
  //    snapshot is FRESH: when the bg routine engine is frozen (tickStale →
  //    health-tick-stale already fires) the in-engine account-state read is
  //    blinded into a false all-paused reading (EI-1695: accounts:status showed
  //    7/8 available during the freeze). Suppressing it here folds the false
  //    rate-starvation blocker into the one health-tick-stale root cause.
  const tk = health.panels.tokens?.data;
  if (!tickStale && tk && tk.accountsTotal > 0 && tk.accountsAvailable === 0) {
    signals.push({
      key: 'accounts-starved',
      severity: 'blocker',
      summary: `all ${tk.accountsTotal} LLM pool account(s) paused — the fleet is rate-starved.`,
    });
  }

  // 5b. PG RESTART (P-008, mcp-reliability-hardening). The postmaster boot time
  //     (infra panel) DRIFTED since the previous tick → Postgres was restarted, so
  //     every backend connection + prepared statement was dropped fleet-wide. This
  //     was a SILENT class: the 2026-07-10 21:04 EDT restart (an agent's
  //     `sudo apt-get install postgresql-server-dev-18 bison flex` triggered the
  //     postgresql-common maintainer scripts to restart the live cluster) went
  //     undetected until downstream errors surfaced. Fires only when a PRIOR
  //     baseline exists (prev != null — the first observation just seeds it, never
  //     alarms) and the current reading is present (cur != null — an unreadable PG
  //     tick is the pg panel's own concern, not a false "restart"). Transient by
  //     design: the tick updates its baseline to the new value, so this fires once
  //     then auto-resolves next tick — a "PG just restarted, connections blipped"
  //     page, not a stuck condition.
  const curPostmasterStartMs = health.panels.infra?.data?.pg?.postmasterStartMs ?? null;
  const prevPostmasterStartMs = opts.prevPostmasterStartMs ?? null;
  if (
    prevPostmasterStartMs !== null &&
    curPostmasterStartMs !== null &&
    curPostmasterStartMs !== prevPostmasterStartMs
  ) {
    const at = new Date(curPostmasterStartMs).toISOString();
    signals.push({
      key: 'pg-restarted',
      severity: 'blocker',
      summary:
        `Postgres RESTARTED (postmaster start-time drifted to ${at}) — every backend connection + prepared ` +
        `statement was dropped; agents may have hit transient DB errors. If UNPLANNED, root-cause it (a ` +
        `\`sudo apt-get install postgresql-*\` / cluster op restarts the live server — do package work off-hours ` +
        `or against embedded-pg, never the shared :5432).`,
    });
  }

  // 5c. EI-9794: autoloop FIRE-RECENCY staleness — independent of `last_status` /
  //     `consecutive_errors` (frozen the instant a loop stops firing) and of the
  //     `armed` wake-routine bit (a self-deactivating one-shot's normal resting
  //     state is indistinguishable from a failed re-arm — see the type doc
  //     above). A role EXPECTED to be running whose `autoloop_state.last_fired_at`
  //     is stale by more than N cadences is silently dead — page it like any
  //     other dead routine.
  const staleMultiplier = autoloopFireStaleMultiplier();
  for (const row of opts.autoloopFireRows ?? []) {
    if (!row.expected || row.lastFiredAtMs === null) continue;
    const thresholdMs = row.cadenceSec * 1000 * staleMultiplier;
    const staleForMs = health.evaluatedAt - row.lastFiredAtMs;
    if (staleForMs > thresholdMs) {
      signals.push({
        key: `autoloop-fire-stale:${row.role}`,
        severity: 'blocker',
        summary:
          `${row.role}@${row.harnessSlug} has not fired in ${Math.round(staleForMs / 60_000)}m ` +
          `(expected every ${row.cadenceSec}s, alarm threshold ${staleMultiplier}x) — last_status may still ` +
          `read 'ok' since that field only updates on a fire. The supervisor is likely dead; kettle:start to resume.`,
      });
    }
  }

  // 6. Catch-all: any OTHER panel self-reporting `crit` (so a new critical signal
  //    is never silently missed). Sharper-keyed panels above are skipped.
  //    NOTE: the panel KEY for the Queen/Mug card is the STABLE identifier
  //    `'queen'` (types.ts PANEL_LABELS maps queen: 'Mug' — key-stable,
  //    label-renamed seam, cup-lexicon-full-rename-2026-07-09 KEEP-set). A
  //    2026-07-05 edit mis-renamed this entry to the display label `'mug'`,
  //    which never matches `panel.key` — so the queen-dark signal (#3 above)
  //    was silently duplicated by this catch-all whenever the queen panel
  //    went crit. Bug found + fixed 2026-07-10 (cup-lexicon-full-rename
  //    fleet read-only-prep pass, su-78d15).
  const coveredKeys = new Set(['workFeed', 'queen', 'tokens']);
  for (const panel of Object.values(health.panels)) {
    if (panel.status !== 'crit' || coveredKeys.has(panel.key)) continue;
    // EI-2146 #3 + EI-15006: suppress the no-bees-while-idle FALSE POSITIVE.
    // A fleet with zero bees running is CORRECT when the pot is idle by design —
    // no admissible cup-placeable frontier is being left unplaced AND capacity is
    // healthy (spawner/engine provably live) — so it is an idle fleet, not an
    // infra fault. Only the specific no-bees case is gated; a bees-crit for any
    // OTHER reason (a cursed placement while bees run: running > 0) still surfaces.
    if (panel.key === 'bees' && health.panels.bees?.data?.running === 0) {
      // EI-15006: with the threaded cup-placeable + capacity context, suppress
      // ONLY the idle-by-design case (no cup work + spawner provably live +
      // capacity not known-exhausted). A genuine spawner-down / cup-work-waiting
      // / cup-tier-full shape still fires — the two false-directions the raw
      // `frontier === 0` gate got wrong (false page during idle; false SILENCE of
      // a real spawner-down when the frontier read empty).
      if (opts.beesLiveness) {
        if (beesIdleByDesign(opts.beesLiveness)) continue;
      } else if (health.panels.workFeed?.data?.frontier === 0) {
        // LEGACY EI-2146 gate for a caller that did not thread the context (an
        // old/pure evaluator) — byte-identical to the pre-EI-15006 behavior.
        continue;
      }
    }
    signals.push({ key: `panel:${panel.key}`, severity: 'blocker', summary: `${panel.label}: ${panel.summary}` });
  }

  return signals;
}

// ── durable per-signal signature (dedup + auto-resolve key) ────────────────────

/** The summary prefix every fired escalation carries. */
const SUMMARY_PREFIX = '[infra-liveness] ';

/** Reverse map a panel LABEL back to its key, for classifying legacy records.
 * Includes the PRE-pot-rename display labels (WI-2932): escalation rows written
 * before the rename carry them in their summaries forever, and this map exists
 * precisely to classify those old rows — the aliases stay as long as any do. */
const PANEL_LABEL_TO_KEY: Record<string, PanelKey> = {
  ...Object.fromEntries(
    (Object.entries(PANEL_LABELS) as Array<[PanelKey, string]>).map(([k, v]) => [v, k]),
  ),
  // LEGACY aliases — the PRE-rename display labels that old escalation summaries
  // carry forever. The spread above already provides the CURRENT labels (Mug,
  // Kettle, …); these must stay the OLD words so records written before the
  // cup-lexicon rename still classify. Do NOT rename these to Mug/Kettle.
  Queen: 'queen',
  'Bees / fleet': 'bees',
  Overwatch: 'overwatch',
  'Scout / ideation': 'scout',
};

/**
 * Derive a signal's stable signature from an escalation summary — the fallback
 * for LEGACY records written before EI-2146 (which carry no explicit signature),
 * so the one-time backlog sweep can classify and auto-resolve the existing pile.
 * Mirrors the summaries produced by `evaluateLivenessAlarm`. Returns null when
 * the summary is not a recognizable infra-liveness signal (left untouched).
 */
export function deriveSignatureFromSummary(summary: string): string | null {
  let s = summary ?? '';
  if (s.startsWith(SUMMARY_PREFIX)) s = s.slice(SUMMARY_PREFIX.length);
  s = s.trim();
  if (s.startsWith('system-health tick stale')) return 'health-tick-stale';
  if (/dead routine\(s\)/.test(s)) return 'dead-routines';
  // Dual-recognition: legacy records carry 'Queen'/'Overwatch'; post-rename
  // records carry 'Mug'/'Kettle'. Match both so the classifier never regresses
  // on the old backlog it exists to sweep.
  if (s.startsWith('Queen loop dark') || s.startsWith('Mug loop dark')) return 'queen-dark';
  if (s.startsWith('Overwatch supervisor loop dark') || s.startsWith('Kettle supervisor loop dark'))
    return 'overwatch-dark';
  if (/LLM pool account\(s\) paused/.test(s)) return 'accounts-starved';
  if (s.startsWith('Postgres RESTARTED')) return 'pg-restarted';
  // EI-9794 fire-staleness form: "<role>@<harness> has not fired in ...".
  const fireStaleMatch = /^([^@\s]+)@\S+ has not fired in/.exec(s);
  if (fireStaleMatch) return `autoloop-fire-stale:${fireStaleMatch[1]}`;
  // Catch-all panel form: "<panel label>: <panel summary>".
  const idx = s.indexOf(': ');
  if (idx > 0) {
    const key = PANEL_LABEL_TO_KEY[s.slice(0, idx)];
    if (key) return `panel:${key}`;
  }
  return null;
}

/**
 * The stable signature of an open escalation: the explicit `livenessSignature`
 * stamped on records this alarm writes (EI-2146), else derived from the summary
 * (legacy). Null = not classifiable as an infra-liveness signal.
 */
export function livenessSignatureOf(rec: EscalationRecord): string | null {
  const explicit = (rec as Record<string, unknown>).livenessSignature;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return deriveSignatureFromSummary(rec.summary ?? '');
}

// ── tick + debounce + starter ─────────────────────────────────────────────────

const lastAlertedAt = new Map<string, number>();

// ── EI-9939: flap-episode tracking (suppress fleet-wide re-broadcast of a
// FLAPPING condition_key) ───────────────────────────────────────────────────
//
// The auto-resolve leg above deliberately clears `lastAlertedAt` on recovery
// ("so a genuine re-occurrence after recovery re-fires immediately") — correct
// for a real second incident, but for a condition that flaps (fires, recovers,
// re-fires, repeatedly — e.g. the routine-engine-starvation dead-routines flap
// observed 2026-07-11/12, repeat_count up to 31 within one session) it means
// EVERY flap cycle re-broadcasts a fresh `page()` alarm + `pageResolved()`
// all-clear to `to:['*']` — every live + parked session, none of whom own the
// flapping routine. Pure context tax.
//
// This map is DISTINCT from `lastAlertedAt` / `openBySig` dedup — a single
// SUSTAINED incident (fires once, stays open until it genuinely resolves)
// never creates more than one episode entry and is completely unaffected;
// only a fire→resolve→refire PATTERN engages it. Only `blocker`-severity
// signals participate (advisory signals never call `page()` regardless).
interface FlapEpisode {
  /** Fires observed since this episode opened. The episode is NOT time-boxed
   *  by a fixed origin window — it stays open (and, once past threshold,
   *  suppressed) for as long as the signature keeps re-firing, however long
   *  that continues; it closes ONLY via the settle sweep (a full flap window
   *  of genuine quiet), which deletes the entry so a later occurrence starts
   *  fresh. This is deliberate: a fixed "reset 30min after the first fire"
   *  origin would let an hours-long flap earn a fresh non-suppressed
   *  broadcast pair every 30min even though it never actually stopped. */
  fireCount: number;
  /** epoch ms the condition most recently went quiet (no longer firing) with
   *  no page() broadcast for that recovery yet, or null while it is either
   *  currently firing or its recovery was already broadcast. The settle
   *  sweep watches this: once quiet for a full flap window with no re-fire,
   *  it is genuinely settled and gets exactly one final all-clear. */
  quietSinceMs: number | null;
}
const flapEpisodes = new Map<string, FlapEpisode>();

/** The SETTLE duration: how long a signature must stay quiet (no re-fire)
 *  before a suppressed flap episode is considered genuinely over and earns
 *  its one final all-clear. 30min — matches the escalation debounce. */
const DEFAULT_FLAP_WINDOW_MS = DEFAULT_DEBOUNCE_MS;
/** Fires 1 and 2 of an episode page normally (byte-identical to today's
 *  behavior — see the "re-fires only after recovery" test); the 3rd+ fire
 *  of the SAME still-open episode is classified as flapping and its page()
 *  is suppressed (the durable escalation row is still written either way). */
const DEFAULT_FLAP_THRESHOLD = 2;

/** P-008: the per-workspace baseline for the PG postmaster boot time (epoch ms).
 *  A change between ticks = a PG restart → the `pg-restarted` signal. In-memory +
 *  per-worker like `lastAlertedAt`; the durable openBySig dedup collapses the
 *  cross-worker fire into one escalation, and a fresh process re-seeds (prev=null)
 *  so a restart never false-fires on the first tick after a :3070 restart. */
const lastPostmasterStartMs = new Map<string, number>();

export interface AlarmDeps {
  computeHealth?: (ws: string) => Promise<SystemHealth>;
  readLast?: (ws: string) => SystemHealth | null;
  /**
   * WI-4773: authoritative CROSS-PROCESS bg-host heartbeat. The request worker's
   * `lastSystemHealth` cache is process-local, so its age cannot prove whether the
   * separate bg-host ticker is alive. Production reads the shared DBOS
   * `routinesTick` watermark; tests that inject `readLast` retain the legacy cache
   * seam unless they explicitly inject this reader too.
   */
  readRoutineEngineLiveness?: (nowMs: number) => Promise<RoutineEngineLiveness>;
  escalate?: (input: {
    severity: EscalationSeverity;
    summary: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  /** The currently-OPEN infra-liveness escalations — the durable dedup +
   *  auto-resolve source. Default reads a bounded newest-first window of the
   *  escalation log and filters to this alarm's identity. */
  listOpen?: () => Promise<EscalationRecord[]>;
  /** Resolve one open escalation by msg_id (auto-resolve-on-recovery). The
   *  RESOLVED value matters (WI-4181): resolveEscalation's no-op sentinels
   *  ('not_found' | 'already_resolved' | 'requires_spawn_approve') mean nothing
   *  transitioned, so the tick suppresses the recovery broadcast; any other
   *  resolution (including undefined from a test double) counts as a real
   *  open→resolved transition. */
  resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  now?: () => number;
  snapshotStaleMs?: number;
  debounceMs?: number;
  /** EI-9939: the rolling window a repeated fire/resolve cycle is measured
   *  against to classify a signature as FLAPPING (default: 30min, same as
   *  `debounceMs`). Test-overridable so a flap scenario doesn't need real
   *  wall-clock minutes. */
  flapWindowMs?: number;
  /** EI-9939: fires within `flapWindowMs` beyond this count are suppressed
   *  (default 2 — the 3rd+ fire in the window is the flap). */
  flapThreshold?: number;
  /** WI-4023: active paging for a NEW `blocker` signal (default: real notifyAttention +
   *  broadcastSevereEvent). Inject a no-op in tests — the default hits the REAL owner
   *  push + fleet broadcast, which a test exercising the blocker path must never do. */
  page?: (s: AlarmSignal, ws: string) => Promise<void>;
  /** WI-4023: the fleet all-clear for recovered `blocker` signatures (default: real
   *  broadcastSevereEventResolvedMany). Inject a no-op in tests for the same reason. */
  pageResolved?: (sigs: string[]) => Promise<void>;
  /** P-008: read/write the per-workspace PG postmaster-start baseline (epoch ms) the
   *  `pg-restarted` drift signal compares against. Default = the module-level map;
   *  tests inject a controlled store to exercise the seed→drift→auto-resolve sequence
   *  hermetically. */
  readPostmasterBaseline?: (ws: string) => number | null;
  writePostmasterBaseline?: (ws: string, ms: number) => void;
  /** EI-9794: fresh `autoloop_state` fire-recency rows for the fire-staleness
   *  signal (5c above). Default = `defaultReadAutoloopFireRows` (kettle/overwatch
   *  today — the proven incident; other supervisor roles with a known cadence +
   *  expected-predicate can extend the same reader). Fail-soft → []: a read
   *  failure must never crash the request worker nor synthesize a false alarm. */
  readAutoloopFireRows?: (ws: string) => Promise<AutoloopFireRow[]>;
  /** EI-15006: read the cup(bee)-tier dispatch budget + fresh-restart flag from the
   *  gateway capacity oracle, for the `panel:bees` idle-by-design gate. Default =
   *  `readGatewayBeeCapacity` (a live gateway fetch, fail-soft to unknown). Injected
   *  by tests to exercise the gate hermetically without real gateway I/O. */
  readBeeCapacity?: () => Promise<{ dispatchBudget: number | null; restartRecovering: boolean }>;
}

async function defaultReadRoutineEngineLiveness(nowMs: number): Promise<RoutineEngineLiveness> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    return await readSharedRoutineEngineLiveness(getOrgPg().sql, {
      staleMs: DEFAULT_SNAPSHOT_STALE_MS,
      nowMs,
    });
  } catch {
    return { stale: false, unknown: true, lastTickMs: null, staleMs: null };
  }
}

/**
 * EI-9794 default `readAutoloopFireRows` — kettle/overwatch, the diagnosed
 * incident. Resolves the pot's home harness the same way `kettle:start` /
 * `isOverwatchAlive` do, reads its `autoloop_state` row (role = OVERWATCH_ROLE),
 * and reuses the EXACT `overwatchExpected` + `getOverwatchCadenceSec` predicates
 * the wake-liveness leg already trusts — so this alarm can never disagree with
 * "is kettle expected to be running" from a second, drifted implementation.
 */
async function defaultReadAutoloopFireRows(ws: string): Promise<AutoloopFireRow[]> {
  try {
    const [{ resolvePotHomeSlug }, { getOrgPg }, { overwatchExpected }, { getOverwatchCadenceSec }, { OVERWATCH_ROLE }] =
      await Promise.all([
        import('../pot/wake'),
        import('@papercusp/db-org'),
        import('../overwatch/cross-monitor'),
        import('../overwatch/control-state'),
        import('../overwatch/liveness'),
      ]);
    const installSlug = resolvePotHomeSlug(undefined, undefined);
    if (!installSlug) return [];
    const [expected, cadenceSec] = await Promise.all([
      overwatchExpected(ws, installSlug),
      getOverwatchCadenceSec(ws, installSlug),
    ]);
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ last_fired_at: Date | string | null }>>`
      SELECT last_fired_at FROM harness_shared.autoloop_state
       WHERE workspace_id = ${ws} AND harness_slug = ${installSlug} AND role = ${OVERWATCH_ROLE}
       LIMIT 1
    `;
    const raw = rows[0]?.last_fired_at ?? null;
    const lastFiredAtMs = raw == null ? null : new Date(raw).getTime();
    return [
      {
        role: OVERWATCH_ROLE,
        harnessSlug: installSlug,
        lastFiredAtMs: Number.isFinite(lastFiredAtMs) ? lastFiredAtMs : null,
        cadenceSec,
        expected,
      },
    ];
  } catch {
    return []; // fail-soft: never synthesize a false alarm from a broken read
  }
}

/** Exported (not module-private) so the EI-10060 route leg is directly
 *  unit-testable against mocked notifyAttention/broadcastSevereEvent — see
 *  liveness-alarm-route.test.ts. */
export async function defaultPage(s: AlarmSignal, ws: string): Promise<void> {
  try {
    await notifyAttention({
      kind: 'intervention',
      title: 'Infra-liveness BLOCKER',
      body: s.summary,
      importance: 'urgent',
      workspaceId: ws,
      data: { signal: s.key },
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
  try {
    // EI-10060: resolve the responsible party for this SIGNAL (raw s.key — the
    // registry keys off the un-prefixed condition class; the broadcast's own
    // `conditionKey` below stays `infra-liveness:${s.key}`-prefixed for the
    // WI-1444 lifecycle join, a SEPARATE concern from ownership). Additive: the
    // fleet-wide broadcast below is unchanged either way; a resolved owner just
    // ALSO gets a directed, woken, full-fidelity notice.
    const route = resolveSevereEventOwner(s.key);
    // EI-14091: the panel:bees signal ("no bees running") measures ONLY
    // Mug-placed cups — a human reading a bare blocker escalation for it can
    // misread "no bees" as "the whole fleet is idle". Fold the scope caveat
    // into the escalation BODY itself (not just the summary text, which can
    // be re-worded independently) so every reader gets it, not only readers
    // who separately consult the Kettle brief.
    const beesScopeCaveat =
      s.key === 'panel:bees'
        ? ` NOTE: this measures only Mug-placed cup agents, not the broader SU/agent fleet — ` +
          `cross-check fleet:assignments / coord:presence before treating this as a whole-fleet outage.`
        : '';
    await broadcastSevereEvent({
      summary: `${SUMMARY_PREFIX}${s.summary}`,
      body:
        `Detected by the request-path infra-liveness alarm (R4-3/R4-8), independent of the background ` +
        `routine engine. Signal: ${s.key}. Workspace: ${ws}. See harness_escalations for the durable record.${beesScopeCaveat}`,
      category: 'severe-event',
      conditionKey: `infra-liveness:${s.key}`,
      ...(route ? { route: { ownerSelector: route.ownerSelector, reason: route.reason } } : {}),
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

async function defaultPageResolved(sigs: string[]): Promise<void> {
  if (sigs.length === 0) return;
  try {
    await broadcastSevereEventResolvedMany({
      conditionKeys: sigs.map((sig) => `infra-liveness:${sig}`),
      summary: `infra-liveness RECOVERED (${sigs.join(', ')}) — condition(s) no longer firing.`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

/** Bound the per-tick escalation-log read: large enough to cover the recently-
 *  open infra-liveness set (and the recovered cohort on the first sweep), small
 *  enough not to re-load the whole ~13k backlog every ~2min (cf. EI-1490). */
const OPEN_SCAN_WINDOW = 500;

/**
 * One alarm tick: prefer the warm cache (cheap when the bg tick is alive), else
 * compute fresh (and the staleness is itself a signal). Then, against the OPEN
 * infra-liveness escalations (EI-2146):
 *   - auto-resolve every open escalation whose condition no longer fires (the
 *     one-time backlog sweep on the first post-deploy tick), and
 *   - fire each NEW signal, durably deduped (one open row per signature, across
 *     workers + restarts) and in-memory cooldown-debounced.
 * Best-effort: never throws.
 */
export async function runLivenessAlarmTick(
  workspaceId?: string,
  deps: AlarmDeps = {},
): Promise<{ fired: AlarmSignal[]; signals: AlarmSignal[]; resolved: string[] }> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = (deps.now ?? Date.now)();
  const readLast = deps.readLast ?? lastSystemHealth;
  const compute = deps.computeHealth ?? computeSystemHealth;
  const escalate = deps.escalate ?? ((input) => openEscalation(INFRA_LIVENESS_IDENTITY, input));
  const listOpen =
    deps.listOpen ??
    (async () => {
      const { escalations } = await listEscalationsPaginated({ status: 'open', maxRecords: OPEN_SCAN_WINDOW });
      return escalations.filter((e) => e.from === INFRA_LIVENESS_IDENTITY.ownerId);
    });
  const resolve =
    deps.resolve ??
    ((msg_id, choice, note) =>
      resolveEscalation({ msg_id, choice, note, resolver: INFRA_LIVENESS_IDENTITY.ownerId }));
  const staleMs = deps.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const flapWindowMs = deps.flapWindowMs ?? DEFAULT_FLAP_WINDOW_MS;
  const flapThreshold = deps.flapThreshold ?? DEFAULT_FLAP_THRESHOLD;
  // WI-4023: paging defaults to a NO-OP here — a bare call to this pure(ish) tick
  // function (every unit test) must NEVER fire a real owner push / fleet broadcast.
  // The live scheduled loop (startInfraLivenessAlarm below) explicitly wires the
  // real defaultPage/defaultPageResolved. Getting this backwards (real-by-default)
  // is exactly the bug that fired live false alarms during this fix's own first
  // test run — see the coord broadcast + apology, 2026-07-11 02:10Z.
  const page = deps.page ?? (async () => {});
  const pageResolved = deps.pageResolved ?? (async () => {});

  const cached = readLast(ws);
  const localSnapshotAgeMs = cached ? now - cached.evaluatedAt : null;
  const localSnapshotStale = localSnapshotAgeMs === null || localSnapshotAgeMs > staleMs;
  const health = localSnapshotStale ? await compute(ws) : (cached as SystemHealth);

  // WI-4773: `lastSystemHealth` is an in-memory Map. In production the periodic
  // writer runs in papercup-bg-host while this alarm runs in a :3070 request
  // worker, so the local cache can age forever while the real engine is healthy.
  // Gate the engine-death signal on the shared DBOS routinesTick watermark. The
  // unknown case is fail-soft (no fabricated outage), matching probeBgHostTicker.
  // Existing unit fixtures that inject only the local cache keep their hermetic
  // legacy behavior; production and the new recurrence tests take this branch.
  const readRoutineEngine =
    deps.readRoutineEngineLiveness ?? (deps.readLast === undefined ? defaultReadRoutineEngineLiveness : null);
  const routineEngine = readRoutineEngine
    ? await readRoutineEngine(now).catch(
        () => ({ stale: false, unknown: true, lastTickMs: null, staleMs: null }) as RoutineEngineLiveness,
      )
    : null;
  // If we recomputed fresh due to local cache staleness, report the freshly-computed
  // snapshot as fresh (null age) so it isn't double-penalized as "stale" by the alarm
  // evaluator. Otherwise use the routine-engine staleness or local cache age.
  const snapshotAgeMs = localSnapshotStale
    ? null  // We just recomputed fresh, so don't report it as stale
    : routineEngine
      ? routineEngine.unknown || !routineEngine.stale
        ? null
        : (routineEngine.staleMs ?? staleMs + 1)
      : localSnapshotAgeMs;
  const lastSuccessfulTickMs = routineEngine?.lastTickMs ?? cached?.evaluatedAt ?? null;

  // P-008: the PG-restart drift baseline. Read the previous postmaster-start value,
  // evaluate against it, then advance it to the current reading — but ONLY when PG
  // was readable this tick (cur != null). An unreadable tick must not clobber the
  // baseline, else the next readable tick would false-fire a "restart".
  const readBaseline = deps.readPostmasterBaseline ?? ((w: string) => lastPostmasterStartMs.get(w) ?? null);
  const writeBaseline = deps.writePostmasterBaseline ?? ((w: string, ms: number) => void lastPostmasterStartMs.set(w, ms));
  const prevPostmasterStartMs = readBaseline(ws);

  // EI-9794: fetch fresh fire-recency rows every tick (cheap — one indexed PK
  // read + two already-cached control-state reads) rather than folding into the
  // cached SystemHealth snapshot, so this signal is NEVER blinded by a stale
  // cache the way tickStale-suppressed signals can be — it is the one check that
  // must keep evaluating even when everything else is frozen.
  const readAutoloopFireRows = deps.readAutoloopFireRows ?? defaultReadAutoloopFireRows;
  const autoloopFireRows = await readAutoloopFireRows(ws).catch(() => [] as AutoloopFireRow[]);

  // EI-15006: the cup-placeable + capacity gate for the `panel:bees` "no bees
  // running" signal. Fetch the bee-tier capacity ONCE per tick (fail-soft to
  // unknown), then derive the context per-snapshot so the recovery-recompute
  // below re-evaluates the FRESH frontier under the same capacity reading.
  // Mirror the readRoutineEngine gating: a test that injects `readLast` (the
  // hermetic-cache seam) gets the no-I/O unknown-capacity stub unless it
  // explicitly injects `readBeeCapacity`, so a unit tick never hits the gateway.
  const readBeeCapacity =
    deps.readBeeCapacity ??
    (deps.readLast === undefined
      ? readGatewayBeeCapacity
      : async () => ({ dispatchBudget: null as number | null, restartRecovering: false }));
  const beeCapacity = await readBeeCapacity().catch(() => ({ dispatchBudget: null, restartRecovering: false }));

  let signals = evaluateLivenessAlarm(health, snapshotAgeMs, {
    snapshotStaleMs: staleMs,
    prevPostmasterStartMs,
    autoloopFireRows,
    beesLiveness: beesLivenessFromHealth(health, beeCapacity),
    ...(snapshotAgeMs !== null && snapshotAgeMs > staleMs
      ? { stallDiagnosis: diagnoseHealthTickStall(health, snapshotAgeMs, now, lastSuccessfulTickMs) }
      : {}),
  });
  let currentSigs = new Set(signals.map((s) => s.key));

  const curPostmasterStartMs = health.panels.infra?.data?.pg?.postmasterStartMs ?? null;
  if (curPostmasterStartMs !== null) writeBaseline(ws, curPostmasterStartMs);

  // Read the open infra-liveness escalations ONCE, bucketed by signature. The
  // durable, cross-worker/cross-restart dedup the in-memory debounce cannot give.
  // Fail-soft: a log-read error degrades to the in-memory debounce only — it must
  // never crash the request worker nor block a genuine alarm.
  let openBySig = new Map<string, EscalationRecord[]>();
  try {
    for (const rec of await listOpen()) {
      const sig = livenessSignatureOf(rec);
      if (!sig) continue;
      const list = openBySig.get(sig);
      if (list) list.push(rec);
      else openBySig.set(sig, [rec]);
    }
  } catch {
    openBySig = new Map();
  }

  // WI-4878: if there are open escalations but no newly-firing signals, ensure
  // we use fresh health data (not a stale cache) when checking for recovery.
  // A cached snapshot can blind the auto-resolve detector: if the cache was
  // computed while failures were active, it would keep showing those failures
  // even after they roll out of the 1h window, so the signal would never stop
  // firing and recovery would never be detected. Recompute fresh when we have
  // open escalations that SHOULD be recovering (no signals currently firing for
  // their signatures).
  //
  // BUGFIX: recovery detection must run REGARDLESS of cache freshness. If the
  // cache was stale (> 6 min old), line 762 already computed a fresh snapshot.
  // If there are open escalations, we must check if they've recovered against
  // that fresh data. The prior condition `&& !localSnapshotStale` was inverted:
  // it skipped recovery detection WHEN the cache was stale, which is exactly
  // when we'd just computed fresh and should CHECK. Now we always check when
  // escalations are open; if the cache is merely fresh (< 6 min), we recompute
  // once more to be sure; if stale, we use the fresh snapshot from line 762.
  if (openBySig.size > 0) {
    const sigsShouldRecover = Array.from(openBySig.keys()).some((sig) => !currentSigs.has(sig));
    if (sigsShouldRecover) {
      // Recompute fresh health snapshot for accurate recovery detection
      // (or verify the fresh snapshot we computed on line 762).
      const freshHealth = localSnapshotStale ? health : await compute(ws);
      signals = evaluateLivenessAlarm(freshHealth, null, {
        snapshotStaleMs: staleMs,
        prevPostmasterStartMs,
        autoloopFireRows,
        beesLiveness: beesLivenessFromHealth(freshHealth, beeCapacity),
      });
      currentSigs = new Set(signals.map((s) => s.key));
    }
  }

  // 1. Auto-resolve-on-recovery: every open infra-liveness escalation whose
  //    signal is no longer firing. On the first post-deploy tick this drains the
  //    recovered backlog (gateway/accounts/no-bees-while-idle) so the pile clears.
  const resolved: string[] = [];
  const recoveredBlockerSigs: string[] = [];
  for (const [sig, recs] of openBySig) {
    if (currentSigs.has(sig)) continue; // still firing — keep the single open row
    // WI-4181: only a resolve that actually TRANSITIONED the row (wrote the
    // sibling escalation_resolved event) counts. resolveEscalation is idempotent
    // and returns the sentinel strings 'not_found' / 'already_resolved' /
    // 'requires_spawn_approve' WITHOUT writing — and broadcasting recovery on
    // mere PRESENCE of an "open" row turned a fold-window zombie (an old open
    // whose resolution had been evicted from listEscalationsPaginated's bounded
    // resolves window) into a storm: resolve() returned 'already_resolved' every
    // tick, nothing ever re-entered the window, and 17 request workers re-emitted
    // "RECOVERED (health-tick-stale)" every ~2min for ~12h (6,000+ duplicates).
    // Gating on the transition also collapses the multi-worker race on a GENUINE
    // recovery: only the worker whose resolve actually landed announces it.
    let transitioned = false;
    for (const rec of recs) {
      try {
        const outcome = await resolve(rec.msg_id, 'auto-resolved', `infra-liveness signal '${sig}' cleared (condition recovered)`);
        if (outcome === 'not_found' || outcome === 'already_resolved' || outcome === 'requires_spawn_approve') continue;
        resolved.push(rec.msg_id);
        transitioned = true;
      } catch {
        /* a resolve failure must never crash the request worker */
      }
    }
    if (transitioned && recs.some((r) => r.severity === 'blocker')) {
      // EI-9939: a signature already classified as FLAPPING (>flapThreshold
      // fires seen this episode) does NOT get its own recovery broadcast —
      // that would just be the other half of the flap-storm this exists to
      // stop. Mark it quiet-since-now instead; the settle sweep below decides
      // whether/when it earns exactly one final all-clear. A non-flapping
      // signature (≤flapThreshold fires) keeps today's byte-identical
      // behavior: broadcast the recovery immediately.
      const ep = flapEpisodes.get(sig);
      if (ep && ep.fireCount > flapThreshold) {
        ep.quietSinceMs = now;
      } else {
        recoveredBlockerSigs.push(sig);
      }
    }
    // Drop the in-memory cooldown so a genuine re-occurrence after recovery
    // re-fires immediately ("re-fire only after auto-resolve").
    lastAlertedAt.delete(sig);
  }
  // EI-9939 settle sweep: a previously-flapping signature that has stayed
  // quiet (no re-fire) for a FULL flap window is genuinely settled — send the
  // one final recovery broadcast now (it supersedes every earlier alert
  // sharing this condition_key, per coord:inbox's annotateResolvedConditions,
  // so a reader who only saw the FIRST fire still learns it cleared) and reset
  // the episode so a later genuine re-occurrence is treated as a fresh first
  // fire rather than staying suppressed forever.
  for (const [sig, ep] of flapEpisodes) {
    if (ep.quietSinceMs === null) continue;
    if (now - ep.quietSinceMs < flapWindowMs) continue;
    recoveredBlockerSigs.push(sig);
    flapEpisodes.delete(sig);
  }
  // WI-4023: pair the fleet-facing all-clear with the auto-resolve above — see the
  // paging note on the fire loop for why this is needed (a durable escalation row
  // alone is not an active page, so its recovery deserves the same fleet visibility).
  await pageResolved(recoveredBlockerSigs);

  // 2. Fire each NEW signal — durably deduped (skip a signature that already has
  //    an open escalation) then in-memory cooldown-debounced.
  const fired: AlarmSignal[] = [];
  for (const s of signals) {
    if (openBySig.has(s.key)) continue; // an open escalation already covers this signature
    const prev = lastAlertedAt.get(s.key);
    if (prev !== undefined && now - prev < debounceMs) continue;
    lastAlertedAt.set(s.key, now);
    fired.push(s);
    try {
      await escalate({
        severity: s.severity,
        summary: `${SUMMARY_PREFIX}${s.summary}`,
        body:
          `Detected by the request-path infra-liveness alarm (R4-3/R4-8) — it runs on a request worker, ` +
          `independent of the background routine engine, so it fires even when that engine is frozen ` +
          `(the failure that blinds the in-engine watchdog). Signal: ${s.key}. Workspace: ${ws}.`,
        // EI-2146: stamp the signature so dedup + auto-resolve match exactly
        // (no summary-parsing needed for records this alarm writes).
        meta: {
          // EI-11841: stable dedup identity must not include dynamic timing/evidence
          // fields, or concurrent request workers can open duplicate flap rows.
          livenessSignature: s.key,
          dedupKind: 'infra-liveness',
          subjectSignature: s.key,
          ...(s.diagnosis ? { healthTickStallDiagnosis: s.diagnosis } : {}),
          // EI-10060: no registered/derivable owner for this signal — nobody is
          // durably on the hook for it beyond the ambient `to:['*']` broadcast
          // (which digest-suppresses after EI-9939's flap threshold like every
          // other repeat fire). Stamped so a human-facing surface can filter on
          // "escalations nobody owns" instead of that fact staying implicit.
          needsHumanRoute: resolveSevereEventOwner(s.key) === null,
        },
      });
    } catch {
      /* an alarm-send failure must never crash the request worker */
    }
    // WI-4023 (root-cause fix, 2026-07-11): a `blocker` signal used to reach ONLY
    // `openEscalation` — a durable PG row with no active push. Verified live
    // (2026-07-10 20:38-21:22 incident): this alarm fired `health-tick-stale` /
    // `dead-routines` blockers correctly within ~1-8min of the DBOS engine dying,
    // but NOBODY noticed for ~40min because nothing paged — the escalation just sat
    // in `harness_escalations` behind the ambient/no-default-surface coord:inbox
    // filter, alongside 292 OTHER escalations that had aged past the attention
    // threshold unread. git-sync-stall-watchdog.ts already pages on its own alarms
    // (notifyAttention + broadcastSevereEvent) — this brings the SAME active paging
    // to every `blocker`-severity infra-liveness signal, not just git-sync's.
    if (s.severity === 'blocker') {
      // EI-9939: classify this fire against its (possibly still-open) flap
      // episode BEFORE deciding whether to page. Fires 1 and 2 of a fresh or
      // reopened episode always page (byte-identical to pre-EI-9939
      // behavior); the 3rd+ fire of the SAME still-open episode is a flap and
      // is suppressed here (the durable escalation above is written
      // regardless — this only gates the fleet-wide broadcast). The episode
      // has no fixed expiry — see the FlapEpisode doc comment for why.
      const ep = flapEpisodes.get(s.key) ?? { fireCount: 0, quietSinceMs: null };
      ep.fireCount += 1;
      ep.quietSinceMs = null; // firing again cancels any pending settle
      flapEpisodes.set(s.key, ep);
      if (ep.fireCount <= flapThreshold) await page(s, ws);
    }
  }
  return { fired, signals, resolved };
}

/**
 * Start the alarm on a request-worker loop. The timer is `unref`'d so it never
 * keeps the process alive. Env-killable (PAPERCUSP_INFRA_LIVENESS_ALARM=0);
 * interval overridable (PAPERCUSP_INFRA_LIVENESS_ALARM_MS).
 */
export function startInfraLivenessAlarm(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_INFRA_LIVENESS_ALARM === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_INFRA_LIVENESS_ALARM_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  // .then(() => undefined) narrows to Promise<void> for the registry WITHOUT hiding the
  // promise — a tick that looked synchronous would release the re-entrancy guard early.
  const timer = managedSetInterval(
    'liveness-alarm',
    intervalMs,
    () =>
      runLivenessAlarmTick(undefined, { page: defaultPage, pageResolved: defaultPageResolved }).then(
        () => undefined,
        () => undefined,
      ),
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}

/** Test-only — clear the per-signal debounce, the P-008 PG-restart baseline,
 *  AND the EI-9939 flap-episode map (all module-level per-worker state a
 *  hermetic test must reset). */
export function _resetLivenessAlarmDebounce(): void {
  lastAlertedAt.clear();
  lastPostmasterStartMs.clear();
  flapEpisodes.clear();
}
