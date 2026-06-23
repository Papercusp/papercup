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
 */

/** Pool-saturation signal — a projection of the gateway `/stats` headroom (observability.GatewayHeadroom). */
export interface CapacitySignal {
  /** False ⇒ the gateway is down/unreachable; the caller must fail-safe to NO clamp. */
  reachable: boolean;
  /** 0..1+ utilization of the most-constraining unified budget window (1.0 = at cap). */
  utilization?: number;
  /** The whole pool is currently paused (every account rate-throttled). */
  paused?: boolean;
  /** The binding budget window is hard-rejected. */
  rejected?: boolean;
  /** Requests waiting for an admission slot right now (the backlog). */
  queueDepth?: number;
  inFlight?: number;
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
}

export const DEFAULT_CAPACITY_DISPATCH_CONFIG: CapacityDispatchConfig = {
  minHeadroom: 2,
  queueSoftCap: 24,
  utilizationHigh: 0.85,
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

/**
 * PURE: clamp the fresh-spawn `beeHeadroom` to the pool's spare capacity. `factor = min(budgetLeg, queueLeg)`,
 * forced to 0 when the pool is paused/rejected (no capacity at all). The result is floored at `minHeadroom`
 * (but never raised above the raw headroom), so high-priority work always flows. Gateway-unreachable ⇒ NO
 * clamp (fail-safe).
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
  // Budget leg: 1 up to utilizationHigh, then linearly to 0 as util → 1.0 (at cap).
  const span = Math.max(1e-6, 1 - config.utilizationHigh);
  const budgetLeg = util <= config.utilizationHigh ? 1 : clamp01(1 - (util - config.utilizationHigh) / span);
  // Queue leg: 1 at an empty queue, → 0 as queueDepth → queueSoftCap.
  const queueLeg = clamp01(1 - queueDepth / Math.max(1, config.queueSoftCap));
  let factor = Math.min(budgetLeg, queueLeg);
  if (signal.paused || signal.rejected) factor = 0; // no fresh capacity at all → throttle to the floor
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
    reason: throttled
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
    signal = {
      reachable: gw.reachable,
      utilization: gw.utilization,
      paused: gw.paused,
      rejected: gw.rejected,
      queueDepth: gw.queueDepth,
      inFlight: gw.inFlight,
    };
  }
  return computeCapacityHeadroom(beeHeadroom, signal, config);
}
