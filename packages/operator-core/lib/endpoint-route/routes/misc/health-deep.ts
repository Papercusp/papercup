/**
 * GET /api/health/deep — B4 (infra-fail-fast-build-integrity-2026-06-19):
 * SUBSYSTEM-exercising readiness.
 *
 * `/api/health` is pure liveness and `/api/health/ready` is BOOT readiness (DBOS
 * launched) — NEITHER exercises PG or memory. So during the 2026-06-19 :3070
 * outage the host reported "active"/ready (200) while mem0 was wedged
 * (better-sqlite3 ABI mismatch) and every memory-touching handler hung. This
 * probe ROUND-TRIPS PG (`SELECT 1`) + memory (`available()`) under a short
 * deadline, so "a wedged subsystem behind a green check" surfaces here as a 503.
 *
 * Additive — the existing liveness/boot probes are unchanged. Public + cheap
 * (one trivial query, hard deadline). Coordinates with self-healing D-001
 * (su-67d39 owns the loop-saturation-survival angle); this is the
 * subsystem-roundtrip angle.
 *
 * False-alarm guard: a CLEAN "memory disabled/unreachable" (`available()`
 * resolves `{ok:false}`) is NOT a failure — a memory-disabled host (NoopBackend)
 * is healthy. Only a HANG (deadline) or an unexpected throw counts as `down` —
 * which is exactly how the outage manifested (available() never resolved).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { dbosLaunchesHere } from '../../../background-workers';
import { dbosStarted } from '../../../dbos/bootstrap';
import { getMemoryBackend } from '../../../memory/backend';

export type ProbeStatus = 'ok' | 'disabled' | 'down';

export interface SubsystemProbe {
  status: ProbeStatus;
  latencyMs: number;
  detail?: string;
}

/** Per-subsystem round-trip deadline. Generous enough for a cold pool, short
 *  enough that a wedge surfaces fast instead of riding a transport timeout. */
export const DEEP_PROBE_TIMEOUT_MS = 3_000;

/**
 * Race a probe against a deadline. The probe fn returns its non-failure status
 * (`ok` | `disabled`); a throw OR a timeout is mapped to `down`. Never throws.
 */
export async function probeSubsystem(
  fn: () => Promise<ProbeStatus>,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<SubsystemProbe> {
  const t0 = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status, latencyMs: now() - t0 };
  } catch (err) {
    return { status: 'down', latencyMs: now() - t0, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pure readiness predicate (exported for tests). DBOS gates only when enabled
 * (mirrors `isReady` in health-ready). PG `down` is always not-ready (the
 * operator can't serve without PG). Memory `down` (hang/throw) is not-ready;
 * memory `disabled` is a fine config and does NOT gate.
 */
export function computeDeepReadiness(args: {
  dbosEnabled: boolean;
  dbosLaunched: boolean;
  pg: ProbeStatus;
  memory: ProbeStatus;
}): boolean {
  const dbosOk = args.dbosEnabled ? args.dbosLaunched : true;
  const pgOk = args.pg !== 'down';
  const memoryOk = args.memory !== 'down';
  return dbosOk && pgOk && memoryOk;
}

export default defineTool({
  method: 'GET',
  path: '/health/deep',
  auth: 'public',
  async handler() {
    // "Does THIS process run DBOS" — NOT the bare PAPERCUSP_DBOS_ENABLE env flag
    // (set in the shared .env.local that every host sources). A request-only host
    // (BACKGROUND_WORKERS=0, e.g. :3070) delegates DBOS to the bg-host, so its local
    // dbosStarted() is false BY DESIGN and must not perpetually gate readiness to 503.
    const dbosEnabled = dbosLaunchesHere();
    const dbos = dbosStarted();

    const [pg, memory] = await Promise.all([
      probeSubsystem(async () => {
        const { getOrgPg } = await import('@papercusp/db-org');
        await getOrgPg().sql`SELECT 1`;
        return 'ok';
      }, DEEP_PROBE_TIMEOUT_MS),
      probeSubsystem(async () => {
        const avail = await getMemoryBackend().available();
        // A clean {ok:false} means deliberately disabled / cleanly unreachable —
        // NOT the wedge we're guarding against (that HANGS → caught as 'down').
        return avail.ok ? 'ok' : 'disabled';
      }, DEEP_PROBE_TIMEOUT_MS),
    ]);

    const ready = computeDeepReadiness({
      dbosEnabled,
      dbosLaunched: dbos,
      pg: pg.status,
      memory: memory.status,
    });

    return Response.json(
      { ok: ready, ready, dbos, dbosEnabled, pg, memory, ts: new Date().toISOString() },
      { status: ready ? 200 : 503 },
    );
  },
});
