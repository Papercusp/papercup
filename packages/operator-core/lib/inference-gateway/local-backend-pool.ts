/**
 * local-backend-pool — LIVE runtime state for the local inference-backend pool
 * (local-concurrent-inference-2026-07-02 P-004, D-002). The registry
 * (local-backend-store.ts) says what backends EXIST; this module tracks what's
 * HEALTHY and BUSY right now and picks where the next request goes — the local
 * peer of the Claude/Codex `AccountPool` (gateway.ts), with the same
 * `reload(next)` hot-swap shape (B-HOT-1 parity) so a registry change applies
 * to the running gateway without a restart.
 *
 * Selection is least-loaded (fewest in-flight requests) among ENABLED,
 * HEALTHY, under-`maxConcurrent` backends serving the requested model id.
 * Health demotes after HEALTH_FAIL_THRESHOLD consecutive failures — periodic
 * probes (runHealthChecks) AND live request outcomes (recordOutcome) both feed
 * it, so a backend that dies mid-traffic is skipped within 2 failed requests,
 * not just at the next probe tick (mirrors the proactive egress prober's
 * 2-consecutive-failure circuit in gateway.ts).
 */

export type LocalBackendKind = 'llama-server' | 'vllm' | 'ollama';

export interface LocalBackend {
  id: string;
  kind: LocalBackendKind;
  /** No trailing slash. The OpenAI-compatible surface lives at `${baseUrl}/v1/...`. */
  baseUrl: string;
  models: readonly string[];
  maxConcurrent: number;
  enabled: boolean;
}

export interface LocalBackendHealth {
  healthy: boolean;
  lastCheckedAt: number;
  latencyMs: number | null;
  error: string | null;
  consecutiveFailures: number;
}

export interface LocalBackendCandidate {
  backend: LocalBackend;
  inFlight: number;
  healthy: boolean;
}

/** Consecutive failures (probe OR live request) before a backend drops out of
 *  selection. A lone blip doesn't evict it — mirrors the gateway's proactive
 *  egress-probe circuit threshold. */
export const HEALTH_FAIL_THRESHOLD = 2;

export const DEFAULT_HEALTH_TIMEOUT_MS = 4000;

/**
 * Pure selection: the least-loaded eligible backend serving `model`, or null
 * when none qualify (not registered for this model, disabled, unhealthy, or
 * every candidate is already at its `maxConcurrent` ceiling — the caller
 * should shed the request, not queue it against a dead/saturated pool).
 * Ties broken by id for determinism (round-robin-ish across equally-idle
 * backends without needing a cursor).
 */
export function pickLeastLoaded(
  candidates: readonly LocalBackendCandidate[],
  model: string,
  exclude?: ReadonlySet<string>,
): LocalBackend | null {
  const eligible = candidates.filter(
    (c) =>
      c.backend.enabled &&
      c.healthy &&
      c.backend.models.includes(model) &&
      c.inFlight < c.backend.maxConcurrent &&
      !exclude?.has(c.backend.id),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.inFlight - b.inFlight || a.backend.id.localeCompare(b.backend.id));
  return eligible[0].backend;
}

/** Pure health-state transition given one probe/request outcome (testable without a clock/network). */
export function nextHealthState(
  prev: LocalBackendHealth | undefined,
  ok: boolean,
  latencyMs: number,
  error: string | null,
  now: number,
): LocalBackendHealth {
  const consecutiveFailures = ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
  const healthy = ok ? true : consecutiveFailures < HEALTH_FAIL_THRESHOLD && (prev?.healthy ?? true);
  return {
    healthy,
    lastCheckedAt: now,
    latencyMs: ok ? latencyMs : (prev?.latencyMs ?? null),
    error,
    consecutiveFailures,
  };
}

export interface LocalBackendPool {
  /** Read-only snapshot of the live registry (no cursor advance). */
  entries(): readonly LocalBackend[];
  size(): number;
  /** HOT-SWAP the live entries (B-HOT-1 parity) — drops in-flight/health state for ids no longer
   *  present; keeps it for ids that survive the reload (a re-registered backend's live counters
   *  aren't reset by an unrelated sibling's edit). */
  reload(next: readonly LocalBackend[]): void;
  /** Least-loaded eligible backend for `model`, or null (no match / all saturated / all unhealthy).
   *  `exclude` skips ids already tried THIS request (single-attempt in-request failover — the caller
   *  need not wait for HEALTH_FAIL_THRESHOLD failures before trying a sibling backend). */
  select(model: string, exclude?: ReadonlySet<string>): LocalBackend | null;
  recordStart(id: string): void;
  recordEnd(id: string): void;
  inFlight(id: string): number;
  /** Feed a LIVE request's outcome into the health state — lets a mid-traffic death get skipped
   *  within HEALTH_FAIL_THRESHOLD failed requests, without waiting for the next probe tick. */
  recordOutcome(id: string, ok: boolean, error?: string | null): void;
  health(): ReadonlyMap<string, LocalBackendHealth>;
  /** Probe every registered backend's `${baseUrl}/v1/models` (supported by llama-server, vllm, and
   *  ollama's OpenAI-compat surface alike) and update health state. Injectable fetch for tests. */
  runHealthChecks(fetchImpl?: typeof fetch, timeoutMs?: number): Promise<void>;
}

export function createLocalBackendPool(initial: readonly LocalBackend[] = []): LocalBackendPool {
  let backends = new Map<string, LocalBackend>(initial.map((b) => [b.id, b]));
  const inFlightCounts = new Map<string, number>();
  const healthMap = new Map<string, LocalBackendHealth>();

  function candidatesFor(): LocalBackendCandidate[] {
    return [...backends.values()].map((backend) => ({
      backend,
      inFlight: inFlightCounts.get(backend.id) ?? 0,
      // Optimistic default: a backend never checked yet (fresh register, checks not yet ticked) is
      // usable immediately — the FIRST probe or live failure is what demotes it, not silence.
      healthy: healthMap.get(backend.id)?.healthy ?? true,
    }));
  }

  return {
    entries: () => [...backends.values()],
    size: () => backends.size,
    reload(next) {
      const nextIds = new Set(next.map((b) => b.id));
      backends = new Map(next.map((b) => [b.id, b]));
      for (const id of [...inFlightCounts.keys()]) if (!nextIds.has(id)) inFlightCounts.delete(id);
      for (const id of [...healthMap.keys()]) if (!nextIds.has(id)) healthMap.delete(id);
    },
    select(model, exclude) {
      return pickLeastLoaded(candidatesFor(), model, exclude);
    },
    recordStart(id) {
      inFlightCounts.set(id, (inFlightCounts.get(id) ?? 0) + 1);
    },
    recordEnd(id) {
      const cur = inFlightCounts.get(id) ?? 0;
      if (cur <= 1) inFlightCounts.delete(id);
      else inFlightCounts.set(id, cur - 1);
    },
    inFlight: (id) => inFlightCounts.get(id) ?? 0,
    recordOutcome(id, ok, error = null) {
      if (!backends.has(id)) return;
      healthMap.set(id, nextHealthState(healthMap.get(id), ok, healthMap.get(id)?.latencyMs ?? 0, error, Date.now()));
    },
    health: () => new Map(healthMap),
    async runHealthChecks(fetchImpl = fetch, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
      await Promise.all(
        [...backends.values()].map(async (backend) => {
          const startedAt = Date.now();
          let ok = false;
          let error: string | null = null;
          try {
            const r = await fetchImpl(`${backend.baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
            ok = r.ok;
            if (!ok) error = `probe returned ${r.status}`;
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          const latencyMs = Date.now() - startedAt;
          healthMap.set(backend.id, nextHealthState(healthMap.get(backend.id), ok, latencyMs, error, Date.now()));
        }),
      );
    },
  };
}
