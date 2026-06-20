/**
 * system-health/compute — `computeSystemHealth`, the SINGLE aggregator
 * (system-health-tab-2026-06-15 P-002 / P-003, D-001).
 *
 * Reads the same operational sources the manual-overwatch loop hand-queried —
 * the Queen's wake liveness, the bees, the work-feed, tokens/gateway, plans,
 * escalations, autonomy, observations, improvements, infra, the SU fleet — and
 * folds them into ONE `SystemHealth` snapshot. The read-only Health tab renders
 * it; the overwatch brief (overwatch-role C-1) wraps it (D-001 — never two
 * health models that drift).
 *
 * FAIL-SOFT per panel (D-003 / the learning-infra-health stance): each collector
 * runs under `panelSafe`, so a flaky source greys ITS card (`unknown` + the
 * error) and never blanks the tab. `overall` is the worst non-`unknown` panel.
 *
 * Freshness mirrors learning-infra-health: a per-workspace module-singleton
 * cache, a `getSystemHealth` read surface that runs a live tick when stale (the
 * correctness floor — opening the tab always computes fresh), and a periodic
 * `runSystemHealthTick` (DBOS, dbos/periodic-workflows.ts) that invalidates
 * `health.snapshot` so an open tab stays SSE-live.
 */
import { getOrgPg } from '@papercusp/db-org';
import { probeHttpReachable } from '../escalating-http-probe';
import { activeWorkspaceId, readRegistry } from '../workspace-registry';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { notifySyncInvalidate } from '../sync-sse';
import type {
  SystemHealth,
  SystemHealthPanels,
  HealthPanel,
  HealthMetric,
  PanelKey,
  PanelStatus,
  QueenHealth,
  BeesHealth,
  WorkItemsHealth,
  WorkFeedHealth,
  TokensHealth,
  WatchdogHealth,
  DeployHealth,
  PlansHealth,
  EscalationsHealth,
  AutonomyHealth,
  ObservationsHealth,
  ImprovementsHealth,
  InfraHealth,
  SuFleetHealth,
  OverwatchPanelHealth,
} from './types';
import { PANEL_LABELS } from './types';
import { isOperationalEscalation } from '../attention/adapters';
import {
  queenStatus,
  beesStatus,
  workItemsStatus,
  workFeedStatus,
  tokensStatus,
  watchdogStatus,
  deployStatus,
  plansStatus,
  escalationsStatus,
  autonomyStatus,
  improvementsStatus,
  infraStatus,
  overwatchStatus,
  worstStatus,
  deriveQueenAlive,
  QUEEN_STALL_MS,
  WATCHDOG_FIRES_WARN,
} from './thresholds';

const WINDOW_MS = 60 * 60_000; // the dashboard's "this window" lookback (1h)
const DEAD_ROUTINE_OVERDUE_MS = 10 * 60_000;
const PLAN_STALE_MS = 24 * 60 * 60_000;
const ESCALATION_AGING_MS = 6 * 60 * 60_000;

/** Minimal open-escalation shape this panel needs (a superset of EscalationRecord). */
export interface EscalationAgingInput {
  from?: string | null;
  options?: readonly unknown[];
  severity: string;
  ts: string;
}

/**
 * PURE: the human-attention escalations health from the OPEN set.
 *
 * EI-1490: OPERATIONAL escalations (system sender, no options — placement-watchdog
 * cursed-placement / aging sweeps) are auto-GC'd duplicates of the derived
 * `placements.cursed` health metric, NOT human decisions. They flooded the open
 * lane (~13k live), so the old "count every open escalation older than the
 * threshold" reported an impossible "13,246 escalations aging past the attention
 * threshold" — perma-warning this panel and churning overwatch's Queen nudge
 * (escalation-aging) every cycle. This panel measures HUMAN-attention escalations,
 * so the operational flood is excluded from EVERY count here, exactly as the
 * attention reader demotes operational escalations out of "waiting on you"
 * (queue-pending-accuracy D-005, shared classifier `isOperationalEscalation`).
 */
export function computeEscalationsHealth(
  open: readonly EscalationAgingInput[],
  now: number,
  agingMs: number = ESCALATION_AGING_MS,
): EscalationsHealth {
  const bySeverity: Record<string, number> = {};
  let oldest: number | null = null;
  let aging = 0;
  let humanOpen = 0;
  for (const e of open) {
    // Skip the operational flood — it is surfaced by the placements.cursed metric
    // and auto-reconciled, never a human decision aging in the attention queue.
    if (isOperationalEscalation(e.from, (e.options?.length ?? 0) > 0)) continue;
    humanOpen += 1;
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    const t = new Date(e.ts).getTime();
    if (Number.isFinite(t)) {
      if (oldest === null || t < oldest) oldest = t;
      if (now - t > agingMs) aging += 1;
    }
  }
  return {
    open: humanOpen,
    oldestAgeMs: oldest === null ? null : now - oldest,
    bySeverity,
    aging,
  };
}
const GATEWAY_DEFAULT_PORT = 8788;

function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : GATEWAY_DEFAULT_PORT;
}

/** ANY HTTP answer (incl. a 503 pacing pause) = the gateway process is alive;
 *  only an unreachable-on-EVERY-attempt is a real outage. EI-1693/WI-266: a
 *  single 2500ms probe FALSE-NEGATIVES under box load (the gateway answers <1ms
 *  but the timer fires under contention), so retry with an escalating, load-aware
 *  timeout. Delegates to the shared escalating-http-probe — keeps this in
 *  lock-step with learning-infra-health's gateway probe (WI-266: it had drifted).
 *  Exported for the retry test. */
export async function probeGatewayHealthz(timeouts: readonly number[] = [2500, 6000]): Promise<boolean> {
  return (await probeHttpReachable(`http://127.0.0.1:${gatewayPort()}/healthz`, { timeouts })).reachable;
}

interface HealthCtx {
  ws: string;
  now: number;
  hiveSlug: string | null;
  started: boolean;
  /** Shared open-placement read (best-effort; null if it failed). */
  openPlacements: { recovering: number; cursed: number; stranded: number; workingTracked: number } | null;
  /** Shared gateway reachability (null = gateway not in the egress path / flag off). */
  gatewayEnabled: boolean;
  gatewayReachable: boolean | null;
  /** Shared overwatch liveness (B-09): the SAME value feeds the Overwatch panel
   *  (#15) AND `crossMonitor.overwatchAlive` (D-004) — computed once, no drift.
   *  null = not-in-play (flag off / not started) or uncomputable (never a false dark). */
  overwatchAlive: boolean | null;
}

/** Run a collector, degrading its own failure to an `unknown` (greyed) panel —
 *  never a fabricated outage. The whole-snapshot correctness floor (D-003).
 *  Exported for the fail-soft unit test. */
export async function panelSafe<T>(
  key: PanelKey,
  run: () => Promise<Omit<HealthPanel<T>, 'key' | 'label' | 'error'>>,
): Promise<HealthPanel<T>> {
  try {
    const p = await run();
    return { key, label: PANEL_LABELS[key], ...p };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      key,
      label: PANEL_LABELS[key],
      status: 'unknown',
      summary: `unreadable — ${msg}`,
      metrics: [],
      data: null,
      error: msg,
    };
  }
}

function m(label: string, value: string | number, tone?: PanelStatus): HealthMetric {
  return tone ? { label, value, tone } : { label, value };
}

function agoMin(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const min = Math.max(0, (now - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 90) return `${Math.round(min)}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

/** "in 4m" / "in 2h" for a future timestamp; "—" if null, "overdue" if past. */
function untilMin(ms: number | null, now: number): string {
  if (ms === null) return '—';
  const min = (ms - now) / 60_000;
  if (min < 0) return 'overdue';
  if (min < 1) return 'imminent';
  if (min < 90) return `in ${Math.round(min)}m`;
  return `in ${Math.round(min / 60)}h`;
}

// ── collectors ───────────────────────────────────────────────────────────────

async function collectQueen(ctx: HealthCtx): Promise<HealthPanel<QueenHealth>> {
  return panelSafe<QueenHealth>('queen', async () => {
    const { ws, now, hiveSlug, started } = ctx;
    if (!hiveSlug) {
      const data: QueenHealth = {
        hiveSlug: null, started: false, stalled: false, midTurn: false, armed: false,
        lastWakeAt: null, staleForMs: null, nextFireAt: null, cadenceOk: false,
        watchdogFires24h: 0, demand: { todoItems: 0, startedPlans: 0 },
        decisionsWindow: { total: 0, auto: 0, gated: 0 }, workingTracked: 0,
      };
      return { status: 'unknown', summary: 'no hive registered in this workspace', metrics: [], data };
    }
    const { sql } = getOrgPg();
    const { hiveLivenessCheck, hiveMidTurn, hiveDemandCheck, recentWatchdogFires } = await import('../hive/watchdog');
    const [live, midTurn, demand, watchdogFires24h] = await Promise.all([
      hiveLivenessCheck(sql, hiveSlug, { workspaceId: ws, now }),
      hiveMidTurn(hiveSlug).catch(() => false),
      hiveDemandCheck(ws).catch(() => ({ demand: false, todoItems: 0, startedPlans: 0 })),
      recentWatchdogFires(ws, hiveSlug).catch(() => 0),
    ]);
    let decisionsWindow = { total: 0, auto: 0, gated: 0 };
    try {
      const { summarizeDecisionLedger } = await import('../decision-ledger/read');
      const sum = await summarizeDecisionLedger(ws, { sinceMs: now - WINDOW_MS });
      decisionsWindow = {
        total: sum.total,
        auto: sum.byPosture?.auto ?? 0,
        gated: (sum.byPosture?.gated ?? 0) + (sum.byPosture?.proposed ?? 0),
      };
    } catch { /* ledger flag off / not yet populated — leave zeros */ }

    const nextFireAt = live.nextFireAt ? live.nextFireAt.getTime() : null;
    const lastWakeAt = live.staleForMs !== null ? now - live.staleForMs : null;
    const overdue = nextFireAt !== null && now - nextFireAt > 5 * 60_000;
    const hasDemand = demand.demand || demand.todoItems > 0 || demand.startedPlans > 0;
    const stalled =
      started && !midTurn && hasDemand &&
      ((live.staleForMs !== null && live.staleForMs > QUEEN_STALL_MS && !live.armed) || overdue);
    const cadenceOk = started && live.armed && !stalled;

    const data: QueenHealth = {
      hiveSlug, started, stalled, midTurn, armed: live.armed,
      lastWakeAt, staleForMs: live.staleForMs, nextFireAt, cadenceOk,
      watchdogFires24h, demand: { todoItems: demand.todoItems, startedPlans: demand.startedPlans },
      decisionsWindow, workingTracked: ctx.openPlacements?.workingTracked ?? 0,
    };
    const status = queenStatus(data);
    const summary = !started
      ? 'paused — colony idle by choice'
      : stalled
        ? `STALLED ${agoMin(lastWakeAt, now)} — ${live.armed ? 'wake overdue' : 'no wake armed'}, demand queued`
        : midTurn
          ? 'working — turn live now'
          : `looping — last wake ${agoMin(lastWakeAt, now)}, next ${untilMin(nextFireAt, now)}`;
    return {
      status, summary, data,
      link: { label: 'Queen pane', href: '/adv?tab=harnesses' },
      metrics: [
        m('state', !started ? 'paused' : stalled ? 'stalled' : midTurn ? 'working' : 'looping', status),
        m('last wake', agoMin(lastWakeAt, now)),
        m('watchdog 24h', watchdogFires24h, watchdogFires24h >= 3 ? 'warn' : undefined),
        m('decisions', `${decisionsWindow.auto}a/${decisionsWindow.gated}g`),
        m('tracking', data.workingTracked),
      ],
    };
  });
}

async function collectBees(ctx: HealthCtx): Promise<HealthPanel<BeesHealth>> {
  return panelSafe<BeesHealth>('bees', async () => {
    const { gatherLiveBees } = await import('../fleet/placement-gather');
    const bees = await gatherLiveBees(ctx.ws);
    const running = bees.length;
    const alive = bees.filter((b) => b.alive).length;
    const stale = running - alive;
    const orphanedClaims = bees.filter((b) => !b.alive && (b.load ?? 0) > 0).length;
    const totalLoad = bees.reduce((s, b) => s + (b.load ?? 0), 0);
    const op = ctx.openPlacements ?? { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0 };
    const data: BeesHealth = {
      running, alive, stale, orphanedClaims, totalLoad,
      placements: { recovering: op.recovering, cursed: op.cursed, stranded: op.stranded, workingTracked: op.workingTracked },
    };
    const status = beesStatus(data);
    return {
      status,
      summary: running === 0
        ? 'no bees running'
        : `${running} bee(s), ${alive} alive${stale > 0 ? `, ${stale} stale` : ''}${op.cursed > 0 ? `, ${op.cursed} cursed` : ''}`,
      data,
      link: { label: 'Working', href: '/adv?tab=harnesses' },
      metrics: [
        m('running', running),
        m('alive', alive),
        m('stale', stale, stale > 0 ? 'warn' : undefined),
        m('orphaned', orphanedClaims, orphanedClaims > 0 ? 'warn' : undefined),
        m('cursed', op.cursed, op.cursed > 0 ? 'crit' : undefined),
      ],
    };
  });
}

async function collectWorkItems(ctx: HealthCtx): Promise<HealthPanel<WorkItemsHealth>> {
  return panelSafe<WorkItemsHealth>('workItems', async () => {
    const { listWorkItems } = await import('../work-items');
    const items = await listWorkItems({ limit: 2000 });
    const byState: Record<string, number> = {};
    for (const it of items) byState[it.state] = (byState[it.state] ?? 0) + 1;
    const n = (s: string) => byState[s] ?? 0;
    const inProgress = n('wip') + n('in-progress') + n('validating') + n('reviewing');
    // P-008 / P-009: stuck-items metric + reaper liveness (best-effort — a read
    // failure leaves the recovery fields undefined so the panel still renders).
    let recovery: Awaited<ReturnType<typeof import('../work-queue-health').readWorkQueueHealth>> | null = null;
    try {
      const { readWorkQueueHealth } = await import('../work-queue-health');
      recovery = await readWorkQueueHealth(getOrgPg().sql, { workspaceId: ctx.ws });
    } catch { /* leave recovery fields undefined — fail-soft */ }
    const data: WorkItemsHealth = {
      total: items.length, byState,
      todo: n('todo'), inProgress, blocked: n('blocked'),
      needsHuman: n('needs-human') + n('needs_human'), done: n('done') + n('passed') + n('resolved'),
      ...(recovery ? {
        stuckFeatures: recovery.stuckFeatures,
        deadHeldClaims: recovery.deadHeldFeatures,
        deadAssignedIssues: recovery.deadAssignedIssues,
        reaperAgeSec: recovery.reaperAgeMs == null ? null : Math.round(recovery.reaperAgeMs / 1000),
        reaperStale: recovery.reaperStale,
      } : {}),
    };
    const status = workItemsStatus(data);
    const stuckTotal = (data.stuckFeatures ?? 0) + (data.deadHeldClaims ?? 0) + (data.deadAssignedIssues ?? 0);
    const reaperWedged = data.reaperStale === true && data.reaperAgeSec != null;
    return {
      status,
      summary: `${data.total} items — ${data.todo} todo, ${inProgress} in-flight, ${data.blocked} blocked${data.needsHuman > 0 ? `, ${data.needsHuman} need human` : ''}${stuckTotal > 0 ? `, ${stuckTotal} stuck` : ''}${reaperWedged ? ' — REAPER WEDGED' : ''}`,
      data,
      link: { label: 'Working', href: '/adv?tab=harnesses' },
      metrics: [
        m('todo', data.todo),
        m('in-flight', inProgress),
        m('blocked', data.blocked, data.blocked > 0 ? 'warn' : undefined),
        m('needs-human', data.needsHuman, data.needsHuman > 0 ? 'warn' : undefined),
        m('done', data.done),
        ...(recovery ? [
          m('stuck', stuckTotal, stuckTotal > 0 ? 'warn' : undefined),
          m('reaper age', data.reaperAgeSec == null ? '—' : `${data.reaperAgeSec}s`, reaperWedged ? 'crit' : data.reaperStale ? 'warn' : undefined),
        ] : []),
      ],
    };
  });
}

async function collectWorkFeed(ctx: HealthCtx): Promise<HealthPanel<WorkFeedHealth>> {
  return panelSafe<WorkFeedHealth>('workFeed', async () => {
    const { ws, hiveSlug } = ctx;
    let frontier = 0, frontierBlocked = 0, startedPlans = 0;
    if (hiveSlug) {
      try {
        const { surveyHive } = await import('../hive/survey');
        const survey = await surveyHive(ws, hiveSlug);
        frontier = survey.frontier.length;
        frontierBlocked = survey.frontierBlocked;
        startedPlans = survey.plans.length;
      } catch { /* survey unreadable — leave zeros, dead-routine signal still computes */ }
    }
    // Dead routines (EI-584): active routines whose next_fire_at is long overdue —
    // the routinesTick that should claim+fire them isn't, so the feed starves.
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ name: string }>>`
      SELECT name FROM harness_shared.routines
       WHERE active = true AND next_fire_at IS NOT NULL
         AND next_fire_at < now() - make_interval(secs => ${DEAD_ROUTINE_OVERDUE_MS / 1000})
       ORDER BY next_fire_at ASC LIMIT 20`;
    const deadRoutineNames = rows.map((r) => r.name);
    // Auto-eligible-stuck (EI-584): improvements that ARE auto-eligible but sit at
    // attempts:0 — eligible yet never dispatched (the feed isn't pumping them). Read
    // the same digest collectImprovements uses; independent + fail-soft (leave 0).
    let autoEligibleStuck = 0;
    try {
      const { readImprovementItems } = await import('../harness/improvements/read-items');
      const { buildDigest } = await import('../harness/improvements/digest');
      const items = await readImprovementItems({ state: 'open', limit: 1000 });
      const digest = buildDigest(items, { nowMs: ctx.now });
      autoEligibleStuck = digest.autoEligible.filter((i) => (i.attempts ?? 0) === 0).length;
    } catch { /* improvements unreadable — leave 0 (the dead-routine signal still computes) */ }
    const data: WorkFeedHealth = {
      frontier, frontierBlocked, startedPlans, autoEligibleStuck,
      deadRoutines: deadRoutineNames.length, deadRoutineNames,
    };
    const status = workFeedStatus(data);
    return {
      status,
      summary: data.deadRoutines > 0
        ? `DEAD ROUTINE(S): ${deadRoutineNames.slice(0, 3).join(', ')}`
        : `${frontier} ready, ${frontierBlocked} blocked, ${startedPlans} started plan(s)${autoEligibleStuck > 0 ? `, ${autoEligibleStuck} auto-stuck` : ''}`,
      data,
      link: { label: 'Working', href: '/adv?tab=harnesses' },
      metrics: [
        m('frontier', frontier),
        m('blocked', frontierBlocked),
        m('started plans', startedPlans),
        m('auto-stuck', autoEligibleStuck, autoEligibleStuck > 0 ? 'warn' : undefined),
        m('dead routines', data.deadRoutines, data.deadRoutines > 0 ? 'crit' : undefined),
      ],
    };
  });
}

async function collectTokens(ctx: HealthCtx): Promise<HealthPanel<TokensHealth>> {
  return panelSafe<TokensHealth>('tokens', async () => {
    const { buildFleetRateStatus } = await import('../fleet-rate-status');
    const rate = await buildFleetRateStatus(WINDOW_MS);
    const pausedBuckets = rate.buckets.filter((b) => b.paused).length;
    let accountsTotal = 0, accountsPaused = 0;
    try {
      const { loadAccountPool } = await import('../deployment/account-pool-store');
      const pool = await loadAccountPool(ctx.ws);
      accountsTotal = pool.accounts.length;
      accountsPaused = pool.accounts.filter((a) => (a.rate?.pausedUntil ?? 0) > ctx.now).length;
    } catch { /* no account pool configured — single bound credential */ }
    const accountsAvailable = accountsTotal - accountsPaused;
    // Gateway-internal wedge/throttle metrics (B-GW-5): read the gateway's OWN /stats (admission
    // queue + AIMD state) and run the wedge detector. Makes the watchdog's silent auto-restart
    // signature VISIBLE. Only when the gateway is in the egress path AND reachable; fail-soft to
    // null (greyed) otherwise — never blanks the panel.
    let gateway: TokensHealth['gateway'] = null;
    if (ctx.gatewayEnabled && ctx.gatewayReachable) {
      try {
        const { fetchGatewayStatsRaw } = await import('../inference-gateway/observability');
        const { summarizeGatewayMetrics } = await import('../inference-gateway/gateway-wedge');
        const { readGatewayWedge } = await import('./gateway-sample-cache');
        const raw = await fetchGatewayStatsRaw();
        if (raw) {
          const gm = summarizeGatewayMetrics(raw);
          const v = readGatewayWedge(gm, ctx.now);
          gateway = {
            inFlight: gm.inFlight, queueDepth: gm.queueDepth, maxConcurrent: gm.maxConcurrent,
            concurrencyCap: gm.concurrencyCap, shed429: gm.shed429, shedAllThrottled: gm.shedAllThrottled,
            failovers: gm.failovers, upstream429: gm.upstream429, utilizationPct: gm.utilizationPct,
            aimdEffective: gm.aimdEffective, aimdCap: gm.aimdCap,
            wedge: v.wedge, saturated: v.saturated, sustainedThrottle: v.sustainedThrottle, reasons: v.reasons,
          };
        }
      } catch { /* /stats unreadable — leave gateway null (greyed), panel still renders */ }
    }
    const data: TokensHealth = {
      gatewayEnabled: ctx.gatewayEnabled,
      gatewayReachable: ctx.gatewayReachable,
      pausedBuckets, totalBuckets: rate.buckets.length,
      fleetInFlight: rate.fleet.inFlight, fleetCap: rate.fleet.cap,
      spendUsd: rate.usage.spendUsd, windowMs: rate.usage.windowMs,
      accountsTotal, accountsAvailable, accountsPaused,
      gateway,
    };
    const status = tokensStatus(data);
    const spend = `$${data.spendUsd.toFixed(2)}`;
    // The gateway wedge/throttle takes the headline summary when present (the loud signal).
    const gwSummary = gateway?.wedge
      ? `GATEWAY WEDGED — ${gateway.reasons[0] ?? `inFlight ${gateway.inFlight}/${gateway.maxConcurrent}`} (watchdog auto-restarts)`
      : gateway?.sustainedThrottle
        ? `gateway throttling — ${gateway.reasons.find((r) => r.includes('AIMD') || r.includes('throttled')) ?? gateway.reasons[0] ?? 'sustained upstream 429s'}`
        : gateway?.saturated
          ? `gateway saturated — inFlight ${gateway.inFlight}/${gateway.maxConcurrent}, ${gateway.queueDepth} queued`
          : null;
    return {
      status,
      summary: status === 'crit'
        ? (gateway?.wedge ? gwSummary! : (accountsTotal > 0 && accountsAvailable === 0 ? 'all accounts paused — starved' : 'gateway unreachable'))
        : gwSummary
          ?? `${data.fleetInFlight}/${data.fleetCap} in flight, ${spend}/${Math.round(data.windowMs / 60000)}m${pausedBuckets > 0 ? `, ${pausedBuckets} paused bucket(s)` : ''}`,
      data,
      link: { label: 'rate-governor', href: '/adv?tab=overview' },
      metrics: [
        m('in flight', `${data.fleetInFlight}/${data.fleetCap}`),
        m('paused buckets', pausedBuckets, pausedBuckets > 0 ? 'warn' : undefined),
        m('gateway', ctx.gatewayEnabled ? (ctx.gatewayReachable ? 'up' : 'down') : 'direct', ctx.gatewayEnabled && ctx.gatewayReachable === false ? 'crit' : undefined),
        ...(gateway ? [
          m('gw queue', `${gateway.inFlight}/${gateway.maxConcurrent}+${gateway.queueDepth}`, gateway.wedge ? 'crit' : gateway.saturated ? 'warn' : undefined),
          ...(gateway.wedge ? [m('WEDGE', 'yes', 'crit')]
            : gateway.sustainedThrottle ? [m('throttle', 'sustained', 'warn')] : []),
          ...(gateway.shed429 + gateway.shedAllThrottled > 0 ? [m('shed', gateway.shed429 + gateway.shedAllThrottled, 'warn')] : []),
          ...(gateway.failovers > 0 ? [m('failovers', gateway.failovers)] : []),
        ] : []),
        m('accounts', accountsTotal > 0 ? `${accountsAvailable}/${accountsTotal}` : 'n/a', accountsTotal > 0 && accountsAvailable === 0 ? 'crit' : undefined),
        m('spend', spend),
      ],
    };
  });
}

async function collectWatchdog(ctx: HealthCtx): Promise<HealthPanel<WatchdogHealth>> {
  return panelSafe<WatchdogHealth>('watchdog', async () => {
    const { ws, hiveSlug, now } = ctx;
    let fires24h = 0, livenessArmed = false, staleForMs: number | null = null;
    if (hiveSlug) {
      const { sql } = getOrgPg();
      const { hiveLivenessCheck, recentWatchdogFires } = await import('../hive/watchdog');
      const [live, fires] = await Promise.all([
        hiveLivenessCheck(sql, hiveSlug, { workspaceId: ws, now }),
        recentWatchdogFires(ws, hiveSlug).catch(() => 0),
      ]);
      fires24h = fires;
      livenessArmed = live.armed;
      staleForMs = live.staleForMs;
    }
    let recentErrors = 0;
    try {
      const { listToasts } = await import('../toast-log-data');
      const { toasts } = await listToasts({ limit: 200 });
      recentErrors = toasts.filter((t) => t.level === 'error' && now - t.createdAt < 24 * 60 * 60_000).length;
    } catch { /* toast log unavailable */ }
    const data: WatchdogHealth = { fires24h, livenessArmed, staleForMs, recentErrors };
    const status = watchdogStatus(data);
    return {
      status,
      summary: `${fires24h} fallback wake(s)/24h, ${recentErrors} error notif(s), ${livenessArmed ? 'armed' : 'unarmed'}`,
      data,
      link: { label: 'notifications', href: '/adv?tab=overview' },
      metrics: [
        m('fallback wakes', fires24h, fires24h >= 3 ? 'warn' : undefined),
        m('error notifs', recentErrors, recentErrors > 0 ? 'warn' : undefined),
        m('liveness', livenessArmed ? 'armed' : 'unarmed'),
      ],
    };
  });
}

async function collectDeploy(ctx: HealthCtx): Promise<HealthPanel<DeployHealth>> {
  return panelSafe<DeployHealth>('deploy', async () => {
    const { devDeployState } = await import('../dev-deploy-state');
    const s = await devDeployState();
    // git-sync UPSTREAM delivery (EI-18): the worst active `system:git-sync` routine's
    // last push outcome. The deploy refs above are blind to a FAILING push — new local
    // commits keep landing so `lastCommitAtMs` stays fresh — so read the metadata
    // git-sync-action.ts persists. Fail-soft: leave the delivery fields at safe
    // defaults (never-crit) when the routine metadata is unreadable.
    let gitSyncStatus: DeployHealth['gitSyncStatus'] = null;
    let gitSyncConsecutiveErrorTicks = 0;
    let gitSyncLastSyncedAtMs: number | null = null;
    let gitSyncOversizedCount = 0;
    try {
      const { sql } = getOrgPg();
      const rows = await sql<Array<{ metadata: Record<string, unknown> | null }>>`
        SELECT metadata FROM harness_shared.routines
         WHERE target_role = 'system:git-sync' AND active = true AND workspace_id = ${ctx.ws}`;
      for (const r of rows) {
        const md = (r.metadata ?? {}) as Record<string, unknown>;
        const et = Number(md.consecutive_error_ticks ?? 0) || 0;
        // worst-wins: the most-failing routine drives the panel status.
        if (gitSyncStatus === null || et > gitSyncConsecutiveErrorTicks) {
          gitSyncStatus = (md.last_status as DeployHealth['gitSyncStatus']) ?? 'nothing';
          gitSyncConsecutiveErrorTicks = et;
        }
        const ls = typeof md.last_synced_at === 'string' ? Date.parse(md.last_synced_at) : NaN;
        if (!Number.isNaN(ls) && (gitSyncLastSyncedAtMs === null || ls > gitSyncLastSyncedAtMs)) gitSyncLastSyncedAtMs = ls;
        if (Array.isArray(md.last_oversized)) gitSyncOversizedCount += md.last_oversized.length;
      }
    } catch { /* routine metadata unreadable — leave git-sync delivery fields at defaults */ }
    const data: DeployHealth = {
      deployedShortSha: s.deployed?.shortSha ?? null,
      deployedBehindMain: s.deployedBehindMain,
      readyBehindMain: s.readyBehindMain,
      deployedBehindReady: s.deployedBehindReady,
      readyAtMainHead: s.readyAtMainHead,
      deployedAtMs: s.deployedAtMs,
      lastCommitAtMs: s.mainHead?.committedAtMs ?? null,
      errors: s.errors,
      gitSyncStatus,
      gitSyncConsecutiveErrorTicks,
      gitSyncLastSyncedAtMs,
      gitSyncOversizedCount,
    };
    const status = deployStatus(data, ctx.now);
    const pushFailing = status === 'crit'; // deployStatus reds ONLY on git-sync push-failure
    return {
      status,
      summary: pushFailing
        ? `git-sync PUSH FAILING ${data.gitSyncConsecutiveErrorTicks} ticks — commits NOT reaching origin`
        : status === 'unknown'
        ? 'release refs unreadable on this host'
        : `live ${data.deployedShortSha ?? '?'}, ${data.deployedBehindMain ?? '?'} behind staging, sync ${agoMin(data.lastCommitAtMs, ctx.now)}`,
      data,
      link: { label: '/admin/git', href: '/admin/git' },
      metrics: [
        m('behind live', data.deployedBehindMain ?? '?', (data.deployedBehindMain ?? 0) > 80 ? 'warn' : undefined),
        m('not-green', data.readyBehindMain ?? '?'),
        m('last sync', agoMin(data.lastCommitAtMs, ctx.now)),
        m('green tip', data.readyAtMainHead === null ? '?' : data.readyAtMainHead ? 'yes' : 'no'),
        m('git-sync push', pushFailing ? `FAILING ${data.gitSyncConsecutiveErrorTicks}t` : (data.gitSyncStatus ?? 'n/a'), pushFailing ? 'crit' : (data.gitSyncOversizedCount > 0 ? 'warn' : undefined)),
      ],
    };
  });
}

async function collectPlans(ctx: HealthCtx): Promise<HealthPanel<PlansHealth>> {
  return panelSafe<PlansHealth>('plans', async () => {
    const { listPlanIndexRows } = await import('../agent-tools/plans/source');
    const rows = await listPlanIndexRows({ workspaceId: ctx.ws });
    let active = 0, started = 0, shipped = 0, draft = 0, itemsDone = 0, itemsTotal = 0, stalledPlans = 0;
    for (const r of rows) {
      if (r.archived) continue;
      if (r.status === 'active') active++;
      if (r.status === 'shipped') shipped++;
      if (r.status === 'draft') draft++;
      if (r.opStatus === 'started') {
        started++;
        const upd = r.opUpdatedAt ? new Date(r.opUpdatedAt).getTime() : 0;
        if (upd > 0 && ctx.now - upd > PLAN_STALE_MS) stalledPlans++;
      }
      for (const it of r.items ?? []) {
        if (it.status === 'done') { itemsDone++; itemsTotal++; }
        else if (['todo', 'wip', 'blocked', 'needs-human'].includes(it.status)) itemsTotal++;
      }
    }
    const data: PlansHealth = { active, started, shipped, draft, itemsDone, itemsTotal, stalledPlans };
    const status = plansStatus(data);
    return {
      status,
      summary: `${started} started, ${active} active, ${itemsDone}/${itemsTotal} items${stalledPlans > 0 ? `, ${stalledPlans} stalled` : ''}`,
      data,
      link: { label: 'Create', href: '/adv?tab=plans' },
      metrics: [
        m('started', started),
        m('active', active),
        m('items', `${itemsDone}/${itemsTotal}`),
        m('stalled', stalledPlans, stalledPlans > 0 ? 'warn' : undefined),
      ],
    };
  });
}

async function collectEscalations(ctx: HealthCtx): Promise<HealthPanel<EscalationsHealth>> {
  return panelSafe<EscalationsHealth>('escalations', async () => {
    const { listEscalations } = await import('../agent-tools/coordination/escalations');
    const open = await listEscalations({ status: 'open' });
    // EI-1490: human-attention escalations only — the operational flood
    // (placement-watchdog cursed placements / aging sweeps) is excluded so the
    // panel/`aging` count reflects real open decisions, not the ~13k auto-GC'd
    // duplicates of the placements.cursed metric.
    const data = computeEscalationsHealth(open, ctx.now);
    const { open: openCount, oldestAgeMs, bySeverity, aging } = data;
    const oldest = oldestAgeMs === null ? null : ctx.now - oldestAgeMs;
    const status = escalationsStatus(data);
    return {
      status,
      summary: openCount === 0
        ? 'no open escalations'
        : `${openCount} open${aging > 0 ? `, ${aging} aging` : ''}, oldest ${agoMin(oldest, ctx.now)}`,
      data,
      link: { label: 'Needs you', href: '/adv?tab=plans' },
      metrics: [
        m('open', openCount, openCount > 0 ? 'warn' : undefined),
        m('blockers', bySeverity.blocker ?? 0, (bySeverity.blocker ?? 0) > 0 ? 'warn' : undefined),
        m('aging', aging, aging > 0 ? 'warn' : undefined),
        m('oldest', agoMin(oldest, ctx.now)),
      ],
    };
  });
}

async function collectAutonomy(ctx: HealthCtx): Promise<HealthPanel<AutonomyHealth>> {
  return panelSafe<AutonomyHealth>('autonomy', async () => {
    const { sql } = getOrgPg();
    const { readAutonomyPolicy } = await import('../autonomy/policy-store');
    const policy = await readAutonomyPolicy(sql, ctx.ws);
    const byCeiling: Record<string, number> = {};
    let locked = 0;
    for (const p of policy) {
      // The owner-set ceiling (the cap) is the heatmap's cell; the locked count
      // captures the "nothing auto-runs here" categories separately.
      byCeiling[p.ceiling] = (byCeiling[p.ceiling] ?? 0) + 1;
      if (p.locked) locked++;
    }
    let tripwiresArmed = 0, tripwiresTripped = 0, tripwiresReverted = 0;
    try {
      const { listRecentTripwires } = await import('../autonomy/tripwire/store');
      const tw = await listRecentTripwires(sql, ctx.ws, { limit: 200 });
      for (const t of tw) {
        if (t.status === 'armed') tripwiresArmed++;
        else if (t.status === 'tripped') tripwiresTripped++;
        else if (t.status === 'reverted') tripwiresReverted++;
      }
    } catch { /* tripwire table not yet present */ }
    const data: AutonomyHealth = {
      categories: policy.length, locked, byCeiling, tripwiresArmed, tripwiresTripped, tripwiresReverted,
    };
    const status = autonomyStatus(data);
    return {
      status,
      summary: `${policy.length} categories, ${locked} locked, ${tripwiresArmed} armed${tripwiresTripped > 0 ? `, ${tripwiresTripped} tripped` : ''}`,
      data,
      link: { label: 'Autonomy', href: '/settings/autonomy' },
      metrics: [
        m('categories', policy.length),
        m('locked', locked),
        m('armed', tripwiresArmed),
        m('tripped', tripwiresTripped, tripwiresTripped > 0 ? 'warn' : undefined),
      ],
    };
  });
}

async function collectObservations(ctx: HealthCtx): Promise<HealthPanel<ObservationsHealth>> {
  return panelSafe<ObservationsHealth>('observations', async () => {
    const { listIssues } = await import('../issues-engineer');
    const { OBSERVATION_TOPIC } = await import('../harness/improvements/read-items');
    const items = (await listIssues({ topic: OBSERVATION_TOPIC, state: 'open', limit: 500 })) as Array<{
      createdAt?: string; sourceRole?: string | null; origin?: string | null;
    }>;
    const recentByRole: Record<string, number> = {};
    let newestAt: number | null = null;
    for (const it of items) {
      const role = it.sourceRole ?? it.origin ?? 'unknown';
      recentByRole[role] = (recentByRole[role] ?? 0) + 1;
      const t = it.createdAt ? new Date(it.createdAt).getTime() : NaN;
      if (Number.isFinite(t) && (newestAt === null || t > newestAt)) newestAt = t;
    }
    const data: ObservationsHealth = { laneCount: items.length, recentByRole, newestAt };
    const roles = Object.entries(recentByRole).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([r, n]) => `${r}:${n}`).join(', ');
    return {
      status: 'ok',
      summary: items.length === 0 ? 'no open observations' : `${items.length} open${roles ? ` (${roles})` : ''}, newest ${agoMin(newestAt, ctx.now)}`,
      data,
      link: { label: 'Learning', href: '/adv?tab=learning' },
      metrics: [
        m('open', items.length),
        m('newest', agoMin(newestAt, ctx.now)),
        m('roles', Object.keys(recentByRole).length),
      ],
    };
  });
}

async function collectImprovements(ctx: HealthCtx): Promise<HealthPanel<ImprovementsHealth>> {
  return panelSafe<ImprovementsHealth>('improvements', async () => {
    const { readImprovementItems } = await import('../harness/improvements/read-items');
    const { buildDigest } = await import('../harness/improvements/digest');
    const { readOwnerFullAutonomyGrant } = await import('../harness/improvements/full-autonomy-grant');
    const items = await readImprovementItems({ state: 'open', limit: 1000 });
    // The OWNER FULL-AUTONOMY grant (Phase 2): keep the auto/human rollup counts honest —
    // when the grant is on, protected-surface bugs move into the auto lane.
    const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ctx.ws);
    const digest = buildDigest(items, { nowMs: ctx.now, ownerFullAutonomy });
    const data: ImprovementsHealth = {
      open: digest.open,
      autoEligible: digest.autoEligible.length,
      humanQueue: digest.humanQueue.length,
      byKind: digest.byKind,
      bySeverity: digest.bySeverity,
    };
    const status = improvementsStatus(data);
    return {
      status,
      summary: `${data.open} open — ${data.autoEligible} auto, ${data.humanQueue} human`,
      data,
      link: { label: 'Learning', href: '/adv?tab=learning' },
      metrics: [
        m('open', data.open),
        m('auto', data.autoEligible),
        m('human', data.humanQueue),
      ],
    };
  });
}

async function collectInfra(ctx: HealthCtx): Promise<HealthPanel<InfraHealth>> {
  return panelSafe<InfraHealth>('infra', async () => {
    let pg: InfraHealth['pg'] = null;
    try {
      const { pgHealth } = await import('../dev-data');
      const h = await pgHealth();
      pg = { version: h.version, total: h.totalConnections, active: h.activeConnections, idle: h.idleConnections };
    } catch { /* PG unreadable — collector still returns (gateway leg) */ }
    // Per-thread perf-SLO verdict from Lane E's latest perf-signals-v1 capture (F1/
    // P-030). Fail-soft: no capture / E1 not running on this box ⇒ perf null ⇒ infra
    // behaves exactly as before. Per-thread budgets (worker CPU%, event-loop lag,
    // CLOSE_WAIT, reachability) — NEVER loadavg-absolute (128-core box; D-002 reframe).
    let perf: InfraHealth['perf'] = null;
    try {
      const { readLatestPerfSignals, evaluatePerfSignals } = await import('./perf-budgets');
      const sig = await readLatestPerfSignals();
      if (sig) perf = evaluatePerfSignals(sig, ctx.now);
    } catch { /* perf-signals unreadable — leave null */ }
    const data: InfraHealth = { pg, gatewayReachable: ctx.gatewayReachable, perf };
    const status = infraStatus(data);
    const perfCrit = perf?.status === 'crit';
    return {
      status,
      summary: perfCrit
        ? `PER-THREAD WEDGE: ${perf!.reasons[0] ?? 'operator degraded'}`
        : pg
        ? `PG ${pg.active} active / ${pg.total} conns${ctx.gatewayEnabled ? `, gateway ${ctx.gatewayReachable ? 'up' : 'down'}` : ''}${perf?.status === 'warn' ? `, perf warn (${perf.reasons[0] ?? ''})` : ''}`
        : 'PG unreadable',
      data,
      link: { label: 'Tests', href: '/adv?tab=testing' },
      metrics: [
        m('pg conns', pg ? `${pg.active}/${pg.total}` : '?', pg === null ? 'unknown' : undefined),
        m('gateway', ctx.gatewayEnabled ? (ctx.gatewayReachable ? 'up' : 'down') : 'direct', ctx.gatewayEnabled && ctx.gatewayReachable === false ? 'crit' : undefined),
        m('worker cpu', perf?.worstWorkerCpuPct != null ? `${Math.round(perf.worstWorkerCpuPct)}%` : 'n/a'),
        m(':3070 close-wait', perf?.closeWait ?? 'n/a'),
        m('host', perf ? (perf.stale ? 'stale' : (perf.hostState ?? '?')) : 'n/a', perfCrit ? 'crit' : (perf?.status === 'warn' ? 'warn' : undefined)),
      ],
    };
  });
}

async function collectSuFleet(ctx: HealthCtx): Promise<HealthPanel<SuFleetHealth>> {
  return panelSafe<SuFleetHealth>('suFleet', async () => {
    const { listPresence } = await import('../agent-tools/coordination/presence');
    const presence = await listPresence({ workspaceId: ctx.ws });
    const live = presence.filter((p) => !p.stale).length;
    const byRole: Record<string, number> = {};
    for (const p of presence) {
      const role = p.agentRole ?? 'unknown';
      byRole[role] = (byRole[role] ?? 0) + 1;
    }
    const data: SuFleetHealth = { total: presence.length, live, stale: presence.length - live, byRole };
    return {
      status: 'ok',
      summary: `${presence.length} present, ${live} live`,
      data,
      link: { label: 'Working', href: '/adv?tab=harnesses' },
      metrics: [
        m('present', presence.length),
        m('live', live),
        m('stale', data.stale, data.stale > 0 ? 'warn' : undefined),
      ],
    };
  });
}

async function collectOverwatch(ctx: HealthCtx): Promise<HealthPanel<OverwatchPanelHealth>> {
  return panelSafe<OverwatchPanelHealth>('overwatch', async () => {
    const { ws, now, hiveSlug } = ctx;
    // Reuse B-08's read surface (D-006 — never a second aggregation): the persisted
    // started bit + cadence (B-07) + the wake liveness (B-09) + the activation flag.
    const { getOverwatchControlState } = await import('../overwatch/snapshot');
    const cs = await getOverwatchControlState({ workspaceId: ws, hiveSlug: hiveSlug ?? undefined });
    let watchdogFires24h = 0;
    if (cs.hiveSlug) {
      try {
        const { recentOverwatchWatchdogFires } = await import('../overwatch/watchdog');
        watchdogFires24h = await recentOverwatchWatchdogFires(ws, cs.hiveSlug);
      } catch { /* fires table unreadable — leave 0 */ }
    }
    const lastWakeAt = cs.lastWakeAt ? new Date(cs.lastWakeAt).getTime() : null;
    const nextFireAt = cs.nextWakeAt ? new Date(cs.nextWakeAt).getTime() : null;
    const data: OverwatchPanelHealth = {
      flagEnabled: cs.flagEnabled,
      started: cs.started,
      alive: ctx.overwatchAlive,
      armed: cs.armed,
      cadenceSec: cs.cadenceSec,
      lastWakeAt,
      nextFireAt,
      staleForMs: cs.staleForMs,
      watchdogFires24h,
    };
    const status = overwatchStatus(data);
    const stateLabel = !cs.flagEnabled
      ? cs.started ? 'pre-armed' : 'disabled'
      : !cs.started
        ? 'paused'
        : data.alive === false
          ? 'dark'
          : 'looping';
    const summary = !cs.flagEnabled
      ? cs.started
        ? 'pre-armed — started bit set, awaiting the papercusp-overwatch flip (B-12)'
        : 'disabled — papercusp-overwatch flag off (default-off until proven, B-12)'
      : !cs.started
        ? 'paused — supervisor idle by choice'
        : data.alive === false
          ? `DARK ${agoMin(lastWakeAt, now)} — supervisor loop gone, no wake armed`
          : `looping — last wake ${agoMin(lastWakeAt, now)}, next ${untilMin(nextFireAt, now)}`;
    return {
      status, summary, data,
      link: { label: 'Overwatch', href: '/adv?tab=overwatch' },
      metrics: [
        m('state', stateLabel, status === 'crit' ? 'crit' : status === 'warn' ? 'warn' : undefined),
        m('cadence', `${Math.round(cs.cadenceSec / 60)}m`),
        m('last wake', agoMin(lastWakeAt, now)),
        m('next wake', untilMin(nextFireAt, now)),
        m('watchdog 24h', watchdogFires24h, watchdogFires24h >= WATCHDOG_FIRES_WARN ? 'warn' : undefined),
      ],
    };
  });
}

// ── the aggregator ───────────────────────────────────────────────────────────

/**
 * Build the whole-system health snapshot for a workspace. Flag-agnostic (the
 * tab/resolver/tick gate on SYSTEM_HEALTH_TAB; the overwatch brief wraps this
 * regardless). Resolves the hive + the shared open-placement + gateway reads
 * once, then runs every panel collector in parallel under `panelSafe`.
 */
export async function computeSystemHealth(workspaceId?: string): Promise<SystemHealth> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = Date.now();

  // Resolve the hive (prefer a started one) + the shared best-effort reads.
  let hiveSlug: string | null = null;
  let started = false;
  try {
    const { listHives } = await import('../agent-tools/hive/_resolve');
    const { getHiveStarted } = await import('../hive/started');
    const hives = await listHives(ws);
    for (const h of hives) {
      if (await getHiveStarted(ws, h.slug).catch(() => false)) { hiveSlug = h.slug; started = true; break; }
    }
    if (!hiveSlug && hives.length > 0) hiveSlug = hives[0].slug;
  } catch { /* registry unreadable — queen/work-feed degrade to 'unknown' */ }

  let openPlacements: HealthCtx['openPlacements'] = null;
  if (hiveSlug) {
    try {
      const { summarizeOpenPlacements } = await import('../hive/placement-watchdog');
      const op = await summarizeOpenPlacements(ws, hiveSlug);
      openPlacements = { recovering: op.recovering, cursed: op.cursed, stranded: op.stranded, workingTracked: op.workingTracked };
    } catch { /* leave null — queen.workingTracked + bees.placements degrade to 0 */ }
  }

  let gatewayEnabled = false;
  let gatewayReachable: boolean | null = null;
  try {
    gatewayEnabled = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
    if (gatewayEnabled) gatewayReachable = await probeGatewayHealthz();
  } catch { /* flag IO hiccup — treat as direct egress */ }

  // Overwatch liveness (B-09 / D-004) — resolved ONCE here so the SAME value feeds
  // both the Overwatch panel (#15, collectOverwatch) and `crossMonitor.overwatchAlive`
  // (the who-watches-the-watcher reverse leg); two copies of this DID drift once
  // (EI-623, the queenAlive sibling). `null` = not-in-play (flag off / not started)
  // or uncomputable — never a false dark. Dynamic import + fail-soft so the
  // overwatch module can never break the shared health aggregation.
  let overwatchAlive: boolean | null = null;
  if (hiveSlug) {
    try {
      const { isOverwatchAlive } = await import('../overwatch/cross-monitor');
      overwatchAlive = await isOverwatchAlive(ws, hiveSlug, { now });
    } catch {
      /* leave null — overwatch liveness not computable; null = not-computed (D-004) */
    }
  }

  const ctx: HealthCtx = { ws, now, hiveSlug, started, openPlacements, gatewayEnabled, gatewayReachable, overwatchAlive };

  const [
    queen, bees, workItems, workFeed, tokens, watchdog, deploy,
    plans, escalations, autonomy, observations, improvements, infra, suFleet, overwatch,
  ] = await Promise.all([
    collectQueen(ctx), collectBees(ctx), collectWorkItems(ctx), collectWorkFeed(ctx),
    collectTokens(ctx), collectWatchdog(ctx), collectDeploy(ctx), collectPlans(ctx),
    collectEscalations(ctx), collectAutonomy(ctx), collectObservations(ctx),
    collectImprovements(ctx), collectInfra(ctx), collectSuFleet(ctx), collectOverwatch(ctx),
  ]);

  const panels: SystemHealthPanels = {
    queen, bees, workItems, workFeed, tokens, watchdog, deploy,
    plans, escalations, autonomy, observations, improvements, infra, suFleet, overwatch,
  };
  const overall = worstStatus(Object.values(panels).map((p) => p.status));
  // queenAlive — the who-watches-the-watcher LIVENESS signal (D-004), kept DISTINCT
  // from `stalled` (EI-623). ONE shared definition (deriveQueenAlive) so the shared
  // model and the overwatch brief mapper can never drift apart again.
  const queenAlive = deriveQueenAlive(queen.data);

  return {
    workspaceId: ws,
    evaluatedAt: now,
    overall,
    crossMonitor: { queenAlive, overwatchAlive },
    panels,
  };
}

// ── cache + tick + read surface (mirrors learning-infra-health) ──────────────

const cache = new Map<string, SystemHealth>();

/** Last computed snapshot for a workspace, or null. */
export function lastSystemHealth(workspaceId?: string): SystemHealth | null {
  return cache.get(workspaceId ?? activeWorkspaceId()) ?? null;
}

/**
 * One health tick: recompute + cache + invalidate `health.snapshot` so an open
 * Health tab refreshes (SSE-live). Driven by the DBOS periodic workflow; also
 * run on-demand by `getSystemHealth` when the cache is stale.
 */
export async function runSystemHealthTick(workspaceId?: string): Promise<SystemHealth> {
  const ws = workspaceId ?? activeWorkspaceId();
  const health = await computeSystemHealth(ws);
  cache.set(ws, health);
  await notifySyncInvalidate('health.snapshot', undefined).catch(() => {});
  // The Overwatch pane (B-08) reads the SAME SystemHealth as its brief snapshot
  // (overwatch.snapshot, D-006 "one aggregation, two consumers"), so invalidate it
  // on the same tick — the pane stays SSE-live without a second aggregation. Safe
  // no-op when no overwatch pane is subscribed.
  await notifySyncInvalidate('overwatch.snapshot', undefined).catch(() => {});
  return health;
}

/**
 * Pre-warm the per-workspace cache once at boot — the cold-cache perf fix
 * (system-health-tab-2026-06-15 P-003 follow-up). The scheduled DBOS tick
 * (`systemHealthTick`, :10/:40) keeps the cache warm in steady state, but for the
 * ~30s after a boot/deploy the cache is EMPTY, so the FIRST Health tab
 * (`getSystemHealth`) or Overwatch pane (`getOverwatchSnapshot`) open
 * cold-computes the 15-collector aggregation (incl. the ~2.5s gateway probe) ON
 * the user's critical path (the 2-3s load the owner saw). Called once right after
 * DBOS launch (bootstrap.ts): it kicks one tick per registered workspace
 * FIRE-AND-FORGET (never blocks/fails boot) and is gated on the SAME
 * `SYSTEM_HEALTH_TAB` flag as the scheduled tick + the read surface. Returns the
 * number of workspaces whose warm-up was kicked off (0 when the flag is off).
 *
 * `tick` is injectable for unit testing; production passes the real
 * `runSystemHealthTick`.
 */
export async function preWarmSystemHealth(
  tick: (ws: string) => Promise<unknown> = runSystemHealthTick,
): Promise<number> {
  if (!(await getFlag(FLAGS.SYSTEM_HEALTH_TAB, 'system'))) return 0;
  const workspaces = readRegistry().workspaces.map((w) => w.id);
  for (const ws of workspaces) {
    void Promise.resolve(tick(ws)).catch((e) => {
      console.warn(`[system-health] boot pre-warm failed for ${ws}: ${e instanceof Error ? e.message : e}`);
    });
  }
  return workspaces.length;
}

/**
 * Read surface for the `health.snapshot` resolver. Stale-while-revalidate: a
 * present snapshot is served INSTANTLY (the Health tab opens with no spinner);
 * when it's past `maxAgeMs` we ALSO kick a background refresh (the tick
 * invalidates `health.snapshot`, so the open tab updates over SSE). Only a COLD
 * cache blocks on a live tick — the one-time correctness floor. Returns null when
 * the feature flag is off.
 */
export async function getSystemHealth(maxAgeMs = 30_000, workspaceId?: string): Promise<SystemHealth | null> {
  if (!(await getFlag(FLAGS.SYSTEM_HEALTH_TAB, 'system'))) return null;
  const ws = workspaceId ?? activeWorkspaceId();
  const cached = cache.get(ws);
  if (cached) {
    if (Date.now() - cached.evaluatedAt > maxAgeMs) void runSystemHealthTick(ws).catch(() => {});
    return cached;
  }
  return runSystemHealthTick(ws);
}

/** Test-only — clear the per-workspace cache. */
export function _resetSystemHealthCache(): void {
  cache.clear();
}
