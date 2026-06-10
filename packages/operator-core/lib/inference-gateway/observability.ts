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

export interface GatewayHeadroom {
  reachable: boolean;
  accountId?: string;
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
  totalRequests?: number;
  upstream429?: number;
  queued429?: number;
  error?: string;
}

/** Project a raw gateway /stats payload into the normalized headroom read-model. */
export function projectHeadroom(stats: GatewayStats, now = Date.now()): GatewayHeadroom {
  const u = stats.unified;
  return {
    reachable: true,
    accountId: stats.accountId,
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
    totalRequests: stats.totalRequests,
    upstream429: stats.upstream429,
    queued429: stats.queued429,
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
