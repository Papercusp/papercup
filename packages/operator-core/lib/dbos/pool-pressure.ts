/**
 * pool-pressure.ts — a pre-tick PG-connection-pool-starvation gate for
 * routinesTickImpl, symmetric to event-loop-lag-monitor's loopPressure()
 * (backend-reliability-100pct-2026-07-03 P-006/W4; decisions D-002 + D-003).
 *
 * WHY. routinesTickImpl (routines-workflow.ts) enqueues git-sync then awaits a long
 * SERIAL chain of ~15 PG-touching DBOS.runStep sweeps. Two things can freeze it:
 *   (a) an EVENT-LOOP block — ALREADY shed at the tick top via loopPressure();
 *   (b) PG-POOL STARVATION — the UNGUARDED dimension and the real ~8× Jul 1–2 root
 *       cause. When the shared getOrgPg pool is exhausted (all connections held by
 *       concurrent consumers), every sweep's query BLOCKS on connection acquisition →
 *       the tick balloons/freezes → git-sync (enqueued at the tick top) stalls with it
 *       → silent wedge → the external bghost-watchdog does a full restart.
 * There was no shed/assertion symmetric to loopPressure() for the POOL dimension.
 * This adds one: it makes pool starvation a COUNTED, LOGGED, shed-able signal instead
 * of a silent pile-on→freeze→restart. The bghost-watchdog stays as the backstop; the
 * dead-routine detector (system-health) still catches a sustained freeze — this adds
 * the ATTRIBUTION (why the routines went dead) and prevents the tick from worsening
 * the starvation.
 *
 * HOW WE MEASURE (D-003). postgres.js (3.4.9) does NOT expose live pool queue-depth —
 * its `queries`/`open`/`busy`/`reserved` queues are closure-private; only
 * `options.max` is public. So rather than depend on private internals (which break on
 * any postgres upgrade — a clear anti-pattern), we measure the ONE thing that actually
 * starves the tick: how long a trivial acquire+`SELECT 1` takes. Under a healthy pool
 * it returns in a few ms; under a starved pool the probe's own query queues behind the
 * backlog and the latency (or a timeout) IS the starvation signal — a strictly better
 * signal for THIS failure mode than a raw queue-depth number, using only the public API.
 *
 * FAIL-SOFT throughout: any probe error is treated as 'ok' — absence of a clean signal
 * must never cause shedding (the same rule loopPressure() follows when no monitor is
 * running). Telemetry, never a crash.
 */

export type PoolPressure = 'ok' | 'elevated' | 'critical';

/** acquire+`SELECT 1` latency (ms) bands. elevated ⇒ the pool is contended; critical ⇒
 *  starved, shed the tick. Env-tunable so a small embedded-pg host can be stricter.
 *  (Mirrors event-loop-lag-monitor's ELEVATED/CRITICAL_P95_MS shape.) */
export const ELEVATED_PROBE_MS = Math.max(1, Number(process.env.PAPERCUSP_POOL_ELEVATED_MS) || 250);
export const CRITICAL_PROBE_MS = Math.max(
  ELEVATED_PROBE_MS + 1,
  Number(process.env.PAPERCUSP_POOL_CRITICAL_MS) || 2000,
);
/** Hard ceiling on the probe itself — a probe that can't finish in this budget IS
 *  critical (the pool is fully starved). Kept ≥ CRITICAL so a timeout ⇒ critical, and
 *  it bounds the cost the probe adds to an (already-degraded) tick. */
export const PROBE_TIMEOUT_MS = Math.max(
  CRITICAL_PROBE_MS,
  Number(process.env.PAPERCUSP_POOL_PROBE_TIMEOUT_MS) || 3000,
);

/** Pure band classification from an acquire+`SELECT 1` latency (ms). Exported for
 *  tests. Non-finite ⇒ 'ok' (no clean signal ⇒ never shed). Mirrors
 *  classifyLoopPressure exactly. */
export function classifyPoolPressure(
  probeMs: number,
  elevatedMs: number = ELEVATED_PROBE_MS,
  criticalMs: number = CRITICAL_PROBE_MS,
): PoolPressure {
  if (!Number.isFinite(probeMs)) return 'ok';
  if (probeMs >= criticalMs) return 'critical';
  if (probeMs >= elevatedMs) return 'elevated';
  return 'ok';
}

// The most recent probe's latency (ms) + when it ran (epoch ms) — for the same-process
// health fold / tests. 0 until the first probe runs.
let _lastProbeMs = 0;
let _lastProbeAt = 0;
export function lastPoolProbeMs(): number {
  return _lastProbeMs;
}
export function lastPoolProbeAt(): number {
  return _lastProbeAt;
}

// Cumulative count of ticks shed for pool starvation, THIS process. Same-process only
// (the tick runs in the bg-host; the health panel — usually a different worker — uses
// its own probe band, not this counter, so it stays honest cross-process).
let _poolShedCount = 0;
export function poolShedCount(): number {
  return _poolShedCount;
}
/** Record + return the new shed count. Called by routinesTickImpl on a critical shed. */
export function recordPoolShed(): number {
  return ++_poolShedCount;
}

/** The default probe: a trivial `SELECT 1` on the shared org-admin pool — the SAME pool
 *  routinesTickImpl's sweeps use, so its acquisition latency is exactly what the tick
 *  would pay. Imported lazily to keep this module free of a load-time db dependency. */
async function defaultProbe(): Promise<unknown> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql`SELECT 1`;
}

/**
 * Time an acquire+`SELECT 1` against the org pool, bounded by `timeoutMs`. Returns the
 * measured latency (ms) and publishes it to lastPoolProbeMs()/At().
 *   - TIMEOUT (pool can't service a trivial query in the budget) ⇒ returns ≥ CRITICAL
 *     so it always classifies 'critical' (even when a small test `timeoutMs` makes the
 *     raw elapsed sub-critical).
 *   - FAST error (a non-starvation failure — pool ended, bad query, etc.) ⇒ returns the
 *     small elapsed ⇒ 'ok' ⇒ don't shed; the tick's own steps will surface that error.
 * Fully fail-soft — never throws. `runProbe`/`now`/`timeoutMs` are injectable for tests.
 */
export async function probePoolLatencyMs(
  runProbe: () => Promise<unknown> = defaultProbe,
  now: () => number = Date.now,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<number> {
  const start = now();
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('pool-probe-timeout')), timeoutMs);
      // Never keep the process alive on the probe's account.
      if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });
    try {
      await Promise.race([runProbe(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    _lastProbeMs = now() - start;
  } catch (e) {
    const elapsed = now() - start;
    // A genuine TIMEOUT means the pool couldn't service a trivial query within the
    // budget ⇒ force the critical band regardless of the measured elapsed. A non-timeout
    // error (fast query failure) is NOT starvation ⇒ report the small elapsed ⇒ 'ok'.
    const timedOut = e instanceof Error && e.message === 'pool-probe-timeout';
    _lastProbeMs = timedOut ? Math.max(elapsed, CRITICAL_PROBE_MS) : elapsed;
  }
  _lastProbeAt = now();
  return _lastProbeMs;
}

/** Live pool-pressure band from a fresh probe. Fail-soft ('ok' on any probe error). */
export async function poolPressure(
  runProbe: () => Promise<unknown> = defaultProbe,
  now: () => number = Date.now,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<PoolPressure> {
  return classifyPoolPressure(await probePoolLatencyMs(runProbe, now, timeoutMs));
}

/** Test-only: reset the module-global probe + shed state between cases. */
export function __resetPoolPressureForTest(): void {
  _lastProbeMs = 0;
  _lastProbeAt = 0;
  _poolShedCount = 0;
}

/**
 * EI-13108 ask (2): durably record a critical pool-shed event (migration 627,
 * harness_shared.routine_pool_shed_events) so an instrument-staleness consumer
 * can tell "paused by this guardrail" from "dead" during a shed window — the
 * in-memory poolShedCount() above is same-process-only and invisible outside
 * the journal.
 *
 * FIRE-AND-FORGET BY DESIGN: called from routinesTickImpl right after a
 * critical shed, on an already-starved pool — awaiting this insert would pile
 * MORE work onto the exact pool that's starving, worsening the incident this
 * exists to attribute. Never throws; a failed insert is swallowed (best-effort
 * telemetry, never a tick-blocking dependency — mirrors the fail-soft rule the
 * probe itself follows).
 */
async function defaultInsertShedEvent(workspaceId: string, shedCount: number, probeMs: number, host: string): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.routine_pool_shed_events
      (workspace_id, shed_count, probe_ms, host)
    VALUES (${workspaceId}, ${shedCount}, ${Math.round(probeMs)}, ${host})`;
}

async function defaultHostname(): Promise<string> {
  const os = await import('node:os');
  return os.hostname();
}

export function recordPoolShedEvent(
  workspaceId: string,
  shedCount: number,
  probeMs: number = lastPoolProbeMs(),
  // Injectable for tests (mirrors probePoolLatencyMs's `runProbe` pattern); defaults
  // to the real INSERT against the org pool + the real hostname.
  insert: (workspaceId: string, shedCount: number, probeMs: number, host: string) => Promise<void> = defaultInsertShedEvent,
  hostname: () => Promise<string> = defaultHostname,
): void {
  void (async () => {
    try {
      await insert(workspaceId, shedCount, probeMs, await hostname());
    } catch (e) {
      console.warn(`[pool-pressure] recordPoolShedEvent insert failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}

/**
 * Query helper for instrument-staleness consumers: was there a durable
 * critical pool-shed event for `workspaceId` within the last `windowMs`? A
 * true result means "paused by the P-006/W4 guardrail", not "dead" — the
 * caller should treat a stale-looking instrument as shed, not broken, for
 * this window. Fail-soft: any query error returns false (never claims a shed
 * happened on a broken signal; the caller falls back to its normal staleness
 * verdict).
 */
async function defaultQueryShedInWindow(workspaceId: string, windowMs: number): Promise<boolean> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM harness_shared.routine_pool_shed_events
     WHERE workspace_id = ${workspaceId}
       AND at >= now() - (${windowMs}::text || ' milliseconds')::interval
     LIMIT 1`;
  return rows.length > 0;
}

export async function hasPoolShedInWindow(
  workspaceId: string,
  windowMs: number,
  // Injectable for tests; defaults to the real SELECT against the org pool.
  query: (workspaceId: string, windowMs: number) => Promise<boolean> = defaultQueryShedInWindow,
): Promise<boolean> {
  try {
    return await query(workspaceId, windowMs);
  } catch (e) {
    console.warn(`[pool-pressure] hasPoolShedInWindow query failed (non-fatal, treated as no-shed-signal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
