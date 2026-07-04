/**
 * Rate observability read-model for the hive inference gateway (hive-inference-gateway P-014).
 *
 * The gateway is the ONLY thing in the fleet that sees `anthropic-ratelimit-*` on every response
 * (the subprocess path is blind to them — D-006). It exposes its live view at `GET /stats`; this
 * module fetches that and PROJECTS it into a normalized "how close to the cap + how backed up is
 * the queue" read-model the operator `/admin` surface renders. The gateway runs in its own process
 * (separate governor registry), so the operator can't read its buckets directly — it reads them
 * over this localhost hop.
 */
import type { GatewayStats } from './gateway';
import { gatewayPort } from './spawn-env';
import type { RawGatewayStats } from './gateway-wedge';

export interface GatewayHeadroom {
  reachable: boolean;
  accountId?: string;
  /** Epoch ms when the gateway process started, when the live /stats payload is new enough to expose it. */
  processStartedAt?: number;
  /** Milliseconds since the gateway process started. Fresh restarts can briefly report zero capacity. */
  processUptimeMs?: number;
  /** Most-constraining unified window: '5h' | '7d' | 'unified' (D-009). */
  window?: string;
  /** 0..1+ utilization of that window (1.0 = at cap). */
  utilization?: number;
  /** Human percent, rounded. */
  utilizationPct?: number;
  /** Whether the binding window is currently rejected (hard-limited). */
  rejected?: boolean;
  /** Seconds until the binding window resets (0 if unknown / already reset). */
  resetInSec?: number;
  /** Currently paused (any reason) until this epoch ms (0 = not paused). */
  pausedUntil?: number;
  paused?: boolean;
  /** Queue: how many bee requests are forwarding now vs waiting for a slot. */
  inFlight?: number;
  queueDepth?: number;
  /** Per-priority queue breakdown (queen/interactive vs batch). */
  byPriority?: { priority: number; count: number }[];
  /** Per-TIER admission breakdown (gateway-priority-tiers-2026-06-22) — present only when the gateway's
   *  tier layer is on (GATEWAY_PRIORITY_TIERS). The pool-wide `healthyAccounts` capacity denominator, the
   *  reserved tier-1 floor, and per-tier {cap,inFlight,queued}. Feeds the Queen's `fleet:capacity` /
   *  capacity-aware dispatch (the SOURCE-side read of the SHARED oracle, D-007). */
  priorityTiers?: {
    healthyAccounts: number;
    tier1Reserve: number;
    tiers: { tier: number; cap: number | null; inFlight: number; queued: number }[];
  };
  totalRequests?: number;
  upstream429?: number;
  queued429?: number;
  /** RPM-smoothing summary for the bound account (P-005): is the burst-dodging pace ENGAGED, and the
   *  EFFECTIVE inter-request pace (ms) actually enforced on it. `effectivePaceMs > 0` ⇒ requests are
   *  being spaced (smoothing is live, not just configured). Undefined when the gateway has no per-account
   *  governor yet. */
  smoothingEngaged?: boolean;
  smoothRpm?: boolean;
  effectivePaceMs?: number;
  /** The bound account's effective per-minute allowance = floor(rpm × learned factor). */
  effRpm?: number | null;
  error?: string;
}

/** Project a raw gateway /stats payload into the normalized headroom read-model. */
export function projectHeadroom(stats: GatewayStats, now = Date.now()): GatewayHeadroom {
  const u = stats.unified;
  // P-005: surface the bound account's smoothing pace (the /stats `smoothing.byAccount[accountId]` entry).
  const sm = stats.smoothing?.byAccount?.[stats.accountId];
  const processStartedAt = Number.isFinite(stats.processStartedAt) ? stats.processStartedAt : undefined;
  const processUptimeMs = Number.isFinite(stats.processUptimeMs)
    ? stats.processUptimeMs
    : processStartedAt != null
      ? Math.max(0, now - processStartedAt)
      : undefined;
  return {
    reachable: true,
    accountId: stats.accountId,
    processStartedAt,
    processUptimeMs,
    window: u?.window,
    utilization: u?.utilization,
    utilizationPct: u ? Math.round(u.utilization * 100) : undefined,
    rejected: u?.rejected,
    resetInSec: u?.resetAt ? Math.max(0, Math.round((u.resetAt - now) / 1000)) : undefined,
    pausedUntil: stats.pausedUntil,
    paused: stats.pausedUntil > now,
    inFlight: stats.inFlight,
    queueDepth: stats.queueDepth,
    byPriority: stats.admission?.byPriority,
    priorityTiers: stats.priorityTiers,
    totalRequests: stats.totalRequests,
    upstream429: stats.upstream429,
    queued429: stats.queued429,
    smoothingEngaged: stats.smoothing?.engaged,
    smoothRpm: sm?.smoothRpm,
    effectivePaceMs: sm?.effectivePaceMs,
    effRpm: sm?.effRpm,
  };
}

/**
 * Fetch + project the live gateway headroom. Returns `{ reachable:false, error }` when the gateway
 * service is down (never throws) so `/admin` can render "gateway offline" rather than 500.
 */
export async function fetchGatewayHeadroom(
  opts: { port?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayHeadroom> {
  const port = opts.port ?? gatewayPort();
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/stats`, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, error: `gateway /stats ${res.status}` };
    const stats = (await res.json()) as GatewayStats;
    return projectHeadroom(stats);
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort predicate: is the inference gateway WHOLESALE-throttled right now — the
 * bound account paused, or its unified window hard-rejected (the all-accounts 429
 * storm / no-fresh-account state)? Used to tell a CAPACITY-SHED mid-turn spawn death
 * (a transient capacity event — RETRYABLE) from a real launcher-host loss (terminal):
 * a spawn whose 1st gateway call succeeded then exits-1 when its 2nd call hits the
 * all-accounts storm was being mislabeled `infra_loss` / "host dead/unstable", sending
 * debuggers hunting a phantom host bug (spawn-classification audit P-006/H13;
 * agent-insights/rate-limit-is-usually-account-routing-not-capacity Fault #5).
 *
 * Never throws (delegates to fetchGatewayHeadroom, which swallows transport errors) and
 * uses a short timeout so a wedged gateway can't stall the spawn-fire classifier.
 * Returns false when the gateway is unreachable OR healthy — the conservative answer,
 * so the caller keeps the legacy `infra_loss` label and never relabels on uncertainty.
 */
export async function gatewayWholesaleThrottled(
  opts: { port?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  // TEST-SAFE: the DEFAULT path fetches the LIVE :8788 gateway — under a vitest runner that makes any
  // test on the no-turn spawn-classification path (durable-spawn / launch-blueprint) NONDETERMINISTIC
  // (it reads whatever real gateway happens to be running + throttled on the box). Skip the live probe
  // under VITEST → false (the conservative infra_loss default), so the classifier never reaches a live
  // gateway in tests. A test that injects its own `fetchImpl` (observability.test.ts) opts INTO the real
  // logic, so that path still runs. Production (VITEST unset) is unchanged.
  if (process.env.VITEST && !opts.fetchImpl) return false;
  const h = await fetchGatewayHeadroom({ timeoutMs: 800, ...opts });
  if (h.reachable !== true) return false;
  if (h.priorityTiers) {
    const serviceable =
      h.priorityTiers.healthyAccounts > 0 &&
      h.priorityTiers.tiers.some((t) => t.cap === null || t.cap > t.inFlight + t.queued);
    if (serviceable) return false;
  }
  return h.paused === true || h.rejected === true;
}

/**
 * Fetch the RAW gateway `/stats` payload for the wedge/throttle detector (B-GW-5). Unlike
 * `fetchGatewayHeadroom` (which projects the normalized admin read-model), this returns the raw
 * shape the `gateway-wedge` detector reads — typed loosely (`RawGatewayStats`) because the live
 * :8788 binary may predate the B-GW-1 AIMD fields (deploy-skew). Returns `null` (never throws) when
 * the gateway is unreachable so the health collector greys the panel rather than erroring the tab.
 */
export async function fetchGatewayStatsRaw(
  opts: { port?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RawGatewayStats | null> {
  const port = opts.port ?? gatewayPort();
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/stats`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as RawGatewayStats;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
