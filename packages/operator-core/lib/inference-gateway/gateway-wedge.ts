/**
 * Gateway wedge / sustained-throttle DETECTOR — inference-gateway-robustness-audit-2026-06-20 P3
 * (B-GW-5: "Wedge metrics/alerting").
 *
 * The gateway watchdog (`watchdog.mjs`) DETECTS the wedge signature and auto-restarts the
 * :8788 service — but SILENTLY (it only logs to journald). This module is the VISIBILITY half:
 * a pure, unit-tested detector that turns a `/stats` snapshot (+ a prior sample for the temporal
 * "frozen" confirmation) into a structured metric bag + a wedge/throttle verdict the operator
 * surfaces on the Health tab's tokens/gateway panel AND the overwatch brief (the alert path).
 * "Complements the watchdog — it auto-restarts; this makes it VISIBLE."
 *
 * PURE by construction (no I/O, no clock except the injected `now`) so the signatures are trivially
 * testable — `detectGatewayWedge` on a simulated wedge snapshot is the acceptance test.
 *
 * DEPLOY-SKEW SAFE: the `/stats` JSON parsed at runtime comes from whatever gateway BINARY is live
 * on :8788, which may predate the B-GW-1 AIMD fields (`aimd`, `shedAllThrottled`, `concurrencyCap`).
 * Every field beyond the original `/stats` contract is therefore OPTIONAL here and read with a
 * default — so the detector works against both the pre-AIMD and post-AIMD gateway.
 */

/** The subset of the gateway `/stats` payload the detector reads. Fields added by B-GW-1 (AIMD) are
 *  OPTIONAL: a not-yet-redeployed gateway omits them (deploy-skew), so we never hard-depend on them. */
export interface RawGatewayStats {
  totalRequests?: number;
  inFlight?: number;
  queueDepth?: number;
  admission?: { running?: number; queued?: number; maxConcurrent?: number };
  upstream429?: number;
  queued429?: number;
  shed429?: number;
  upstreamErrors?: number;
  failovers?: number;
  /** unified-window utilization fraction (1.0 = at cap). */
  unified?: { utilization?: number };
  // ── B-GW-1 (AIMD) additions — optional until that gateway build is live ──────────────────────
  /** Count of 429s shed at admission because the WHOLE pool was throttled (fail-fast path). */
  shedAllThrottled?: number;
  /** The CONFIGURED admission-concurrency ceiling (AIMD recovers toward it). */
  concurrencyCap?: number;
  /** AIMD admission-concurrency state — `effective < cap` = currently throttled (sustained storm). */
  aimd?: { effective?: number; cap?: number; floor?: number; decreases?: number };
}

/** The structured gateway metrics surfaced on the dashboard (the "emit structured metrics" half). */
export interface GatewayMetrics {
  totalRequests: number;
  inFlight: number;
  queueDepth: number;
  /** Live effective admission cap (AIMD-adjusted when AIMD is active; the configured cap otherwise). */
  maxConcurrent: number;
  /** Configured admission ceiling (AIMD recovers toward it); null on a pre-AIMD gateway. */
  concurrencyCap: number | null;
  shed429: number;
  /** Fail-fast all-throttled shed count; 0 on a pre-AIMD gateway. */
  shedAllThrottled: number;
  failovers: number;
  upstream429: number;
  upstreamErrors: number;
  /** Unified-window utilization %, rounded; null when not seen. */
  utilizationPct: number | null;
  /** AIMD effective concurrency; null on a pre-AIMD gateway. */
  aimdEffective: number | null;
  /** AIMD ceiling; null on a pre-AIMD gateway. */
  aimdCap: number | null;
  /** Lifetime AIMD multiplicative-decrease count (a climbing value = an active storm); null pre-AIMD. */
  aimdDecreases: number | null;
}

/** A minimal rolling sample the detector compares against to confirm the TEMPORAL wedge signature
 *  (frozen `totalRequests`) + a climbing-shed throttle. Persisted in-process by the collector. */
export interface GatewaySample {
  totalRequests: number;
  shed429: number;
  shedAllThrottled: number;
  at: number; // epoch ms the sample was taken
}

/** The wedge/throttle verdict — the alert payload. */
export interface GatewayWedgeVerdict {
  /** Instantaneous wedge-RISK: at the live slot ceiling with work queued (the spatial half of the
   *  signature). On its own → a warn; CONFIRMED into a `wedge` once `totalRequests` also freezes. */
  saturated: boolean;
  /** CONFIRMED wedge: saturated AND `totalRequests` not advancing vs a recent prior — the exact
   *  signature the watchdog restarts on (frozen counter + every slot pinned + a growing queue). */
  wedge: boolean;
  /** Sustained upstream throttle: AIMD cut concurrency below its cap, or the pool is fail-fast
   *  shedding (all accounts throttled), or the admission backlog is overflowing. */
  sustainedThrottle: boolean;
  /** Human reasons (each surfaced on the panel / overwatch anomaly). */
  reasons: string[];
}

/** A prior older than this can no longer CONFIRM a freeze (a long-quiet gateway legitimately has a
 *  flat `totalRequests`; only a RECENT flat-while-saturated reading is the wedge). */
export const WEDGE_FREEZE_PRIOR_MAX_AGE_MS = 5 * 60_000;

function n(v: number | undefined, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Project a raw `/stats` payload into the structured metric bag (deploy-skew safe). */
export function summarizeGatewayMetrics(stats: RawGatewayStats): GatewayMetrics {
  // Prefer the admission snapshot's live values; fall back to the top-level mirrors.
  const inFlight = n(stats.admission?.running, n(stats.inFlight));
  const queueDepth = n(stats.admission?.queued, n(stats.queueDepth));
  const maxConcurrent = n(stats.admission?.maxConcurrent, n(stats.aimd?.cap, n(stats.concurrencyCap)));
  const util = stats.unified?.utilization;
  return {
    totalRequests: n(stats.totalRequests),
    inFlight,
    queueDepth,
    maxConcurrent,
    concurrencyCap: typeof stats.concurrencyCap === 'number' ? stats.concurrencyCap
      : typeof stats.aimd?.cap === 'number' ? stats.aimd.cap
      : null,
    shed429: n(stats.shed429),
    shedAllThrottled: n(stats.shedAllThrottled),
    failovers: n(stats.failovers),
    upstream429: n(stats.upstream429),
    upstreamErrors: n(stats.upstreamErrors),
    utilizationPct: typeof util === 'number' && Number.isFinite(util) ? Math.round(util * 100) : null,
    aimdEffective: typeof stats.aimd?.effective === 'number' ? stats.aimd.effective : null,
    aimdCap: typeof stats.aimd?.cap === 'number' ? stats.aimd.cap : null,
    aimdDecreases: typeof stats.aimd?.decreases === 'number' ? stats.aimd.decreases : null,
  };
}

/** Capture the minimal rolling sample from the current metrics (for the next tick's comparison). */
export function sampleGateway(metrics: GatewayMetrics, now: number): GatewaySample {
  return {
    totalRequests: metrics.totalRequests,
    shed429: metrics.shed429,
    shedAllThrottled: metrics.shedAllThrottled,
    at: now,
  };
}

/**
 * Detect the wedge + sustained-throttle signatures from the current metrics and an optional prior
 * sample. PURE — no I/O. The `prior` lets us confirm the TEMPORAL half of the wedge signature
 * (frozen `totalRequests`); without a prior the verdict reports only the instantaneous `saturated`
 * (a warn), never a false `wedge`.
 *
 * `opts.minFreezeMs` (default 0) requires the prior to be at least that old before a frozen-while-
 * saturated reading counts as a confirmed `wedge` — the caller passes the freeze-ANCHOR sample
 * (held stable since the freeze began) so the wedge only fires once the freeze has PERSISTED that
 * long (defends against a near-simultaneous double-read seeing a ~0ms "frozen" gap).
 */
export function detectGatewayWedge(
  metrics: GatewayMetrics,
  prior: GatewaySample | undefined,
  now: number,
  opts: { minFreezeMs?: number } = {},
): GatewayWedgeVerdict {
  const minFreezeMs = opts.minFreezeMs ?? 0;
  const reasons: string[] = [];

  // ── Saturation (spatial half): every live slot is taken AND work is waiting. ──────────────────
  const saturated = metrics.maxConcurrent > 0 && metrics.inFlight >= metrics.maxConcurrent && metrics.queueDepth > 0;
  if (saturated) {
    reasons.push(`at slot ceiling: inFlight ${metrics.inFlight}/${metrics.maxConcurrent} with ${metrics.queueDepth} queued`);
  }

  // ── Wedge (spatial + temporal): saturated AND totalRequests not advancing vs a PERSISTED prior. ─
  let wedge = false;
  const priorAge = prior ? now - prior.at : -1;
  const priorUsable = !!prior && priorAge >= minFreezeMs && priorAge <= WEDGE_FREEZE_PRIOR_MAX_AGE_MS;
  if (saturated && prior && priorUsable && metrics.totalRequests === prior.totalRequests) {
    wedge = true;
    reasons.push(
      `totalRequests frozen @${metrics.totalRequests} for ${Math.round(priorAge / 1000)}s while saturated — wedge signature (watchdog will auto-restart)`,
    );
  }

  // ── Sustained throttle: the upstream is throttling the pool. ──────────────────────────────────
  let sustainedThrottle = false;
  // (a) AIMD has cut effective concurrency below its configured cap → a sustained 429 storm.
  if (metrics.aimdEffective != null && metrics.aimdCap != null && metrics.aimdEffective < metrics.aimdCap) {
    sustainedThrottle = true;
    reasons.push(`AIMD throttled concurrency to ${metrics.aimdEffective}/${metrics.aimdCap} (sustained upstream 429s)`);
  }
  // (b) Fail-fast all-throttled shedding climbing vs the prior → the whole pool is throttled.
  if (prior && metrics.shedAllThrottled > prior.shedAllThrottled) {
    sustainedThrottle = true;
    reasons.push(`shed ${metrics.shedAllThrottled - prior.shedAllThrottled} request(s) fast — all accounts throttled`);
  }
  // (c) Admission backlog overflowing (load-shed climbing) → the queue can't drain fast enough.
  if (prior && metrics.shed429 > prior.shed429) {
    sustainedThrottle = true;
    reasons.push(`load-shed ${metrics.shed429 - prior.shed429} request(s) — admission backlog full`);
  }

  return { saturated, wedge, sustainedThrottle, reasons };
}
