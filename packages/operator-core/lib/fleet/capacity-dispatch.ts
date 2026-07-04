/**
 * capacity-dispatch — the Queen's capacity-aware dispatch (gateway-priority-tiers-2026-06-22 Phase 4,
 * `QUEEN_CAPACITY_DISPATCH`). The SOURCE-side counterpart to the gateway's priority tiers (SINK-side): before
 * a placement round the Queen reads the inference pool's live saturation (the gateway `/stats` — the SHARED
 * capacity oracle, D-007) and CLAMPS how many FRESH bees it spawns, so it stops flooding the gateway with bee
 * requests that just park/fail when the pool is capacity-scarce. The tiers ALLOCATE scarce capacity fairly;
 * this REDUCES the inflow; NEITHER creates capacity — the durable lever stays more accounts (D-006).
 *
 * `computeCapacityHeadroom` is PURE (fake-signal testable, no I/O); `queenCapacityHeadroom` adds the flag read
 * + the gateway fetch. Flag-OFF, gateway-flag-OFF, or gateway-UNREACHABLE ⇒ NO clamp (fail-safe — never strand
 * the fleet on a missing/stale signal). A `minHeadroom` floor always lets some work through so high-priority
 * tasks still flow (the gateway tiers then prioritize them); the placement planner walks the frontier in
 * importance order, so clamping the fresh-spawn headroom naturally DEFERS the lowest-priority tasks first.
 *
 * `buildCapacityReport` is the PURE read-model the Queen consumes (the `fleet:capacity` tool + the wake-brief
 * Capacity panel both project a gateway headroom snapshot through it) — it lives HERE, with the dispatch
 * domain logic, so no consumer has to depend on the agent-tool module.
 */
import { tierOf, DEFAULT_GATEWAY_PRIORITY_MAP, type PriorityTierMap } from '@papercusp/papercusp-shared/agent';
import type { GatewayHeadroom } from '../inference-gateway/observability';

/** Pool-saturation signal — a projection of the gateway `/stats` headroom (observability.GatewayHeadroom). */
export interface CapacitySignal {
  /** False ⇒ the gateway is down/unreachable; the caller must fail-safe to NO clamp. */
  reachable: boolean;
  /** Milliseconds since the gateway process started, if /stats is new enough to expose it. */
  processUptimeMs?: number | null;
  /** 0..1+ utilization of the most-constraining unified budget window (1.0 = at cap). */
  utilization?: number;
  /** The whole pool is currently paused (every account rate-throttled). */
  paused?: boolean;
  /** The binding budget window is hard-rejected. */
  rejected?: boolean;
  /** Requests waiting for an admission slot right now (the backlog). */
  queueDepth?: number;
  inFlight?: number;
  /** Pool-wide healthy accounts from the gateway tier oracle. */
  healthyAccounts?: number | null;
  /** Spare slots in the bee tier: cap - inFlight - queued. */
  dispatchBudget?: number | null;
}

export interface CapacityDispatchConfig {
  /** Floor — always allow at least this many FRESH spawns so high-priority work still flows (the gateway
   *  tiers then prioritize it); prevents a full placement stall under total exhaustion. Env:
   *  `QUEEN_CAPACITY_MIN_HEADROOM`. Default 2. */
  minHeadroom: number;
  /** `queueDepth` at which the queue leg of the factor reaches 0 (full throttle). Env:
   *  `QUEEN_CAPACITY_QUEUE_SOFT_CAP`. Default 24. */
  queueSoftCap: number;
  /** Utilization above which the budget leg starts throttling (linearly to 0 at util ≥ 1.0). Env:
   *  `QUEEN_CAPACITY_UTIL_HIGH`. Default 0.85. */
  utilizationHigh: number;
  /** Grace window after gateway process start where a paused/zero-capacity snapshot is treated as recovering,
   *  not sustained pool exhaustion. Env: `QUEEN_CAPACITY_RESTART_GRACE_MS`. Default 30s. */
  restartRecoveryWindowMs: number;
}

export const DEFAULT_CAPACITY_DISPATCH_CONFIG: CapacityDispatchConfig = {
  minHeadroom: 2,
  queueSoftCap: 24,
  utilizationHigh: 0.85,
  restartRecoveryWindowMs: 30_000,
};

export interface CapacityDecision {
  /** The clamped fresh-spawn headroom to pass to the placement planner. */
  headroom: number;
  /** The applied capacity factor in [0,1] (1 = no clamp). */
  factor: number;
  /** True when the clamp reduced the headroom below the raw value. */
  throttled: boolean;
  /** Human-readable reason (logged + surfaced on the placement result for observability). */
  reason: string;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function hasTieredBeeCapacity(signal: CapacitySignal): boolean {
  return (signal.healthyAccounts ?? 0) > 0 && (signal.dispatchBudget ?? 0) > 0;
}

function isFreshGatewayRestart(signal: CapacitySignal, config: CapacityDispatchConfig): boolean {
  const uptime = signal.processUptimeMs;
  if (uptime == null || !Number.isFinite(uptime) || uptime < 0) return false;
  if (uptime > Math.max(0, config.restartRecoveryWindowMs)) return false;
  return (signal.paused === true || signal.rejected === true) && !hasTieredBeeCapacity(signal);
}

/**
 * PURE + HEADROOM-INDEPENDENT: the pool's spare-capacity FACTOR in [0,1] (1 = full headroom, 0 = no fresh
 * capacity). `factor = min(budgetLeg, queueLeg)`, forced to 0 when the pool is paused/rejected. This is the
 * single throttle curve `computeCapacityHeadroom` scales the raw headroom by; it is also read directly by the
 * Queen's `fleet:capacity` tool to report saturation without committing to a specific headroom. Gateway-
 * unreachable ⇒ 1 (fail-safe — never clamp on a missing/stale signal).
 */
export function capacityFactor(
  signal: CapacitySignal,
  config: CapacityDispatchConfig = DEFAULT_CAPACITY_DISPATCH_CONFIG,
): number {
  if (!signal.reachable) return 1;
  const tieredSpareCapacity = hasTieredBeeCapacity(signal);
  const accountWindowBlocked = signal.paused === true || signal.rejected === true;
  if (isFreshGatewayRestart(signal, config)) return 1;
  // With priority tiers, `/stats.{unified,paused,rejected}` describe the currently-BOUND account,
  // NOT the pool. If that account is paused/exhausted while the tier oracle still reports healthy
  // accounts AND bee-tier spare slots, pool capacity exists — a bound-account block must not gate
  // placement. (Originally this covered only `rejected`; a weekly-capped account reports BOTH
  // paused:true AND rejected:true, which re-armed the false-saturation gate and stalled the whole
  // autonomous loop — capacity-oracle-false-saturation-2026-06-29.)
  const boundAccountBlockedButPoolHasCapacity = accountWindowBlocked && tieredSpareCapacity;
  const util = boundAccountBlockedButPoolHasCapacity ? 0 : (signal.utilization ?? 0);
  const queueDepth = Math.max(0, signal.queueDepth ?? 0);
  // Budget leg: 1 up to utilizationHigh, then linearly to 0 as util → 1.0 (at cap).
  const span = Math.max(1e-6, 1 - config.utilizationHigh);
  const budgetLeg = util <= config.utilizationHigh ? 1 : clamp01(1 - (util - config.utilizationHigh) / span);
  // Queue leg: 1 at an empty queue, → 0 as queueDepth → queueSoftCap.
  const queueLeg = clamp01(1 - queueDepth / Math.max(1, config.queueSoftCap));
  let factor = Math.min(budgetLeg, queueLeg);
  if (accountWindowBlocked && !boundAccountBlockedButPoolHasCapacity) factor = 0; // no fresh capacity at all → throttle to the floor
  return factor;
}

/**
 * PURE: clamp the fresh-spawn `beeHeadroom` to the pool's spare capacity. The result is floored at
 * `minHeadroom` (but never raised above the raw headroom), so high-priority work always flows.
 * Gateway-unreachable ⇒ NO clamp (fail-safe).
 */
export function computeCapacityHeadroom(
  beeHeadroom: number,
  signal: CapacitySignal,
  config: CapacityDispatchConfig = DEFAULT_CAPACITY_DISPATCH_CONFIG,
): CapacityDecision {
  if (!signal.reachable) {
    return { headroom: beeHeadroom, factor: 1, throttled: false, reason: 'gateway unreachable → no clamp (fail-safe)' };
  }
  const util = signal.utilization ?? 0;
  const queueDepth = Math.max(0, signal.queueDepth ?? 0);
  const factor = capacityFactor(signal, config);
  const freshRestart = isFreshGatewayRestart(signal, config);
  const floor = Math.max(0, Math.floor(config.minHeadroom));
  // Floor lifts the clamp toward minHeadroom, but the result is never MORE than the raw headroom (a 0-slot
  // pool stays 0 — the floor lets high-priority work flow, it doesn't manufacture slots that don't exist).
  const headroom = Math.min(beeHeadroom, Math.max(floor, Math.floor(beeHeadroom * factor)));
  const throttled = headroom < beeHeadroom;
  const pct = Math.round(util * 100);
  return {
    headroom,
    factor,
    throttled,
    reason: freshRestart
      ? `capacity-recovering: gateway restarted ${Math.round((signal.processUptimeMs ?? 0) / 1000)}s ago → no clamp on startup snapshot`
      : throttled
      ? `capacity-throttle: ${beeHeadroom}→${headroom} fresh bees (util ${pct}%, queue ${queueDepth}` +
        `${signal.paused ? ', POOL PAUSED' : ''}${signal.rejected ? ', rejected' : ''}, factor ${factor.toFixed(2)}, floor ${floor})`
      : `capacity-ok: ${beeHeadroom} fresh bees (util ${pct}%, queue ${queueDepth})`,
  };
}

/** Resolve the config from env (`QUEEN_CAPACITY_*`) over optional explicit overrides over the defaults. */
export function resolveCapacityConfig(
  over?: Partial<CapacityDispatchConfig>,
  env: NodeJS.ProcessEnv = process.env,
): CapacityDispatchConfig {
  const num = (raw: string | undefined, fallback: number, min = 0): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    minHeadroom: Math.floor(
      num(env.QUEEN_CAPACITY_MIN_HEADROOM, over?.minHeadroom ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.minHeadroom),
    ),
    queueSoftCap: num(env.QUEEN_CAPACITY_QUEUE_SOFT_CAP, over?.queueSoftCap ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.queueSoftCap, 1),
    utilizationHigh: num(env.QUEEN_CAPACITY_UTIL_HIGH, over?.utilizationHigh ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.utilizationHigh),
    restartRecoveryWindowMs: num(
      env.QUEEN_CAPACITY_RESTART_GRACE_MS,
      over?.restartRecoveryWindowMs ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.restartRecoveryWindowMs,
    ),
  };
}

/**
 * The Queen-side entry: flag-gated (`QUEEN_CAPACITY_DISPATCH`) capacity clamp on the fresh-spawn headroom.
 * Reads the gateway `/stats` (the shared oracle) unless a `signal` is injected (tests). Flag-OFF,
 * gateway-flag-OFF, or gateway-unreachable ⇒ NO clamp (returns the raw headroom).
 */
export async function queenCapacityHeadroom(
  beeHeadroom: number,
  opts: {
    flagOverride?: boolean;
    signal?: CapacitySignal;
    config?: Partial<CapacityDispatchConfig>;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CapacityDecision> {
  const noClamp = (reason: string): CapacityDecision => ({ headroom: beeHeadroom, factor: 1, throttled: false, reason });
  let on = opts.flagOverride;
  if (on === undefined) {
    const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
    on = await getFlag(FLAGS.QUEEN_CAPACITY_DISPATCH, 'system').catch(() => false);
  }
  if (!on) return noClamp('QUEEN_CAPACITY_DISPATCH off → no clamp');

  const config = resolveCapacityConfig(opts.config, opts.env);
  let signal = opts.signal;
  if (!signal) {
    // The gateway is the shared capacity oracle (D-007) — only consult it when the gateway is actually on.
    const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
    const gwOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system').catch(() => false);
    if (!gwOn) return noClamp('inference gateway off → no capacity oracle, no clamp (fail-safe)');
    const { fetchGatewayHeadroom } = await import('../inference-gateway/observability');
    const gw = await fetchGatewayHeadroom({ timeoutMs: opts.timeoutMs ?? 1200 });
    const beeTier = tierOf('bee', DEFAULT_GATEWAY_PRIORITY_MAP);
    const beeRow = gw.priorityTiers?.tiers.find((t) => t.tier === beeTier) ?? null;
    const dispatchBudget = beeRow && beeRow.cap != null ? Math.max(0, beeRow.cap - beeRow.inFlight - beeRow.queued) : null;
    signal = {
      reachable: gw.reachable,
      utilization: gw.utilization,
      paused: gw.paused,
      rejected: gw.rejected,
      queueDepth: gw.queueDepth,
      inFlight: gw.inFlight,
      processUptimeMs: gw.processUptimeMs,
      healthyAccounts: gw.priorityTiers?.healthyAccounts ?? null,
      dispatchBudget,
    };
  }
  return computeCapacityHeadroom(beeHeadroom, signal, config);
}

// ── Capacity read-model (queen-capacity-aware-dispatch-2026-06-22 P-002/P-003) ──────────────────────
// The PURE projection the Queen consumes — the `fleet:capacity` tool returns it whole; the wake-brief
// Capacity panel renders its digest. Composes the SAME `capacityFactor` / `computeCapacityHeadroom` the
// placement path enforces, so what the Queen READS matches what placement DOES.

export interface CapacityReport {
  /** False ⇒ the gateway is down/unreachable; the Queen should place at her normal ceiling (no clamp). */
  reachable: boolean;
  /** Whether the gateway's per-tier layer is active (GATEWAY_PRIORITY_TIERS) — `priorityTiers` present. */
  tierLayer: boolean;
  /** Whether the Queen's automatic placement clamp is armed (QUEEN_CAPACITY_DISPATCH). */
  clampArmed: boolean;
  utilization: number | null;
  utilizationPct: number | null;
  paused: boolean;
  rejected: boolean;
  resetInSec: number | null;
  healthyAccounts: number | null;
  tier1Reserve: number | null;
  /** The admission tier bee work maps to (default 3) — the band `dispatchBudget` is measured in. */
  beeTier: number;
  /** Spare bee-tier slots right now = cap − inFlight − queued (D-001). null when the tier layer is off. */
  dispatchBudget: number | null;
  capByTier: { tier: number; cap: number | null; inFlight: number; queued: number }[] | null;
  inFlight: number | null;
  queueDepth: number | null;
  /** Pool spare-capacity factor in [0,1] (1 = full headroom, 0 = no fresh capacity). */
  factor: number;
  /** When `headroom` was supplied: that raw fresh-spawn count clamped to spare capacity. */
  recommendedHeadroom: number | null;
  throttled: boolean | null;
  /** One-line dispatch advice for the Queen. */
  advice: string;
}

export interface FleetSizingAdvisory {
  requestedMembers: number;
  healthyHeadroom: number;
  extraMembers: number;
  message: string;
}

/**
 * PURE: project a gateway headroom snapshot into the Queen's capacity decision read-model. Testable with a
 * fabricated `GatewayHeadroom` (no I/O). `headroom` is an optional proposed fresh-spawn count to clamp.
 */
export function buildCapacityReport(
  hr: GatewayHeadroom,
  opts: {
    clampArmed: boolean;
    headroom?: number;
    config?: CapacityDispatchConfig;
    tierMap?: PriorityTierMap;
  },
): CapacityReport {
  const config = opts.config ?? resolveCapacityConfig();
  const tierMap = opts.tierMap ?? DEFAULT_GATEWAY_PRIORITY_MAP;
  const beeTier = tierOf('bee', tierMap);

  const signal: CapacitySignal = {
    reachable: hr.reachable,
    utilization: hr.utilization,
    paused: hr.paused,
    rejected: hr.rejected,
    queueDepth: hr.queueDepth,
    inFlight: hr.inFlight,
  };

  if (!hr.reachable) {
    return {
      reachable: false, tierLayer: false, clampArmed: opts.clampArmed,
      utilization: null, utilizationPct: null, paused: false, rejected: false, resetInSec: null,
      healthyAccounts: null, tier1Reserve: null, beeTier,
      dispatchBudget: null, capByTier: null, inFlight: null, queueDepth: null,
      factor: 1, recommendedHeadroom: opts.headroom ?? null, throttled: opts.headroom != null ? false : null,
      advice: 'gateway unreachable → place at your normal ceiling (fail-safe, no capacity clamp)',
    };
  }

  const pt = hr.priorityTiers;
  const capByTier = pt?.tiers ?? null;
  const beeRow = pt?.tiers.find((t) => t.tier === beeTier) ?? null;
  const dispatchBudget = beeRow && beeRow.cap != null ? Math.max(0, beeRow.cap - beeRow.inFlight - beeRow.queued) : null;
  signal.healthyAccounts = pt?.healthyAccounts ?? null;
  signal.dispatchBudget = dispatchBudget;
  const factor = capacityFactor(signal, config);
  const tieredSpareCapacity = hasTieredBeeCapacity(signal);
  // A weekly-capped account reports BOTH paused:true and rejected:true; trust the tier oracle
  // (healthy accounts + bee-tier spare slots) over the bound-account block — same rationale as
  // capacityFactor (capacity-oracle-false-saturation-2026-06-29).
  const boundAccountBlockedButPoolHasCapacity = (hr.rejected || hr.paused) && tieredSpareCapacity;
  const poolBlocked = (hr.paused || hr.rejected) && !boundAccountBlockedButPoolHasCapacity;

  let recommendedHeadroom: number | null = null;
  let throttled: boolean | null = null;
  if (opts.headroom != null) {
    const decision = computeCapacityHeadroom(opts.headroom, signal, config);
    recommendedHeadroom = decision.headroom;
    throttled = decision.throttled;
  }

  const advice = poolBlocked
    ? 'pool SATURATED (paused/rejected) → place ONLY top-ranked tier-1 work; hold bee batch until it recovers'
    : factor <= 0.25
      ? `scarce (factor ${factor.toFixed(2)}) → place the top-ranked items only, hold the rest${dispatchBudget != null ? `; ~${dispatchBudget} bee slots free` : ''}`
      : factor < 1
        ? `tightening (factor ${factor.toFixed(2)}) → trim low-priority placements${dispatchBudget != null ? `; ~${dispatchBudget} bee slots free` : ''}`
        : 'abundant → place broadly up to your ceiling';

  return {
    reachable: true,
    tierLayer: !!pt,
    clampArmed: opts.clampArmed,
    utilization: hr.utilization ?? null,
    utilizationPct: hr.utilizationPct ?? null,
    paused: !!hr.paused,
    rejected: !!hr.rejected,
    resetInSec: hr.resetInSec ?? null,
    healthyAccounts: pt?.healthyAccounts ?? null,
    tier1Reserve: pt?.tier1Reserve ?? null,
    beeTier,
    dispatchBudget,
    capByTier,
    inFlight: hr.inFlight ?? null,
    queueDepth: hr.queueDepth ?? null,
    factor,
    recommendedHeadroom,
    throttled,
    advice,
  };
}

/**
 * PURE: warn when a requested fleet member count exceeds the pool's CURRENT healthy-account
 * headroom. This is a sizing advisory only — not an admission gate — because extra members can
 * still launch, but they'll likely thrash rotation against the same few healthy accounts.
 */
export function buildFleetSizingAdvisory(
  requestedMembers: number,
  report: Pick<CapacityReport, 'reachable' | 'healthyAccounts'>,
): FleetSizingAdvisory | null {
  const requested = Math.max(0, Math.floor(requestedMembers));
  const healthyHeadroom =
    report.reachable && Number.isFinite(report.healthyAccounts)
      ? Math.max(0, Math.floor(report.healthyAccounts ?? 0))
      : null;
  if (healthyHeadroom == null || requested <= healthyHeadroom) return null;
  const extraMembers = requested - healthyHeadroom;
  const accountLabel = healthyHeadroom === 1 ? 'healthy account' : 'healthy accounts';
  const memberLabel = extraMembers === 1 ? 'member' : 'members';
  return {
    requestedMembers: requested,
    healthyHeadroom,
    extraMembers,
    message:
      `Sizing advisory: requested ${requested} fleet members, but only ${healthyHeadroom} ${accountLabel} ` +
      `are currently routable. Launch will continue, but the extra ${extraMembers} ${memberLabel} will likely ` +
      `thrash account rotation / rate-limit churn. Prefer <=${healthyHeadroom} members or add healthy accounts.`,
  };
}
