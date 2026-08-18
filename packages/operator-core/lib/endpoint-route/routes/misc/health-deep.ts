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
import { currentLoopLag, loopPressure } from '../../../event-loop-lag-monitor';
import { getCpuWorkerState, type CpuWorkerVerdict } from '../../../cpu-task-worker';

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

export interface LoopLagReading {
  /** 'ok' when no lag monitor is running (absence of signal, never a false-healthy claim). */
  pressure: 'ok' | 'elevated' | 'critical';
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

/**
 * EI-19285078178745571: a 2026-08-01 incident had EVERY MCP tool call wedged for
 * ~17min while `/api/health` (and this deep probe's own PG/memory legs) kept
 * answering fast — because neither of those legs touches whether the event loop
 * itself is able to timely service queued work; they only prove PG/memory are
 * reachable FROM a loop iteration that got to run. The near-identical 2026-06-19
 * EI-79 outage (sustained synchronous CPU work starving the loop) had the SAME
 * blind spot and is exactly what `event-loop-lag-monitor.ts`'s standing gauge was
 * built to make "self-evident next time" — but that gauge only ever reached a
 * structured console.warn, never an HTTP-visible signal. Surfacing it here closes
 * that gap for an external monitor/dashboard without guessing at a mechanism this
 * file can't reproduce.
 *
 * Deliberately does NOT gate `ready`/503: unlike PG/memory (binary reachable-or-not,
 * and the operator genuinely cannot serve without them), loop pressure is a
 * continuous signal the admission-control layer (mcp-admission.ts) already sheds
 * NEW requests on at the 'critical' band — flipping deep-health to 503 on the same
 * signal would just duplicate that shedding at the readiness layer (risking a
 * legitimate load-balancer / process-supervisor overreaction to a transient,
 * self-recovering spike) instead of adding new information. This is a read-only
 * diagnostic: the raw p95/p99/max let a human or monitor see "the loop was under
 * pressure" even when no threshold breach reads as a hard failure.
 */
export function readLoopLag(): LoopLagReading {
  const lag = currentLoopLag();
  return {
    pressure: loopPressure(),
    p95Ms: lag?.p95Ms ?? null,
    p99Ms: lag?.p99Ms ?? null,
    maxMs: lag?.maxMs ?? null,
  };
}

export interface CpuWorkerReading {
  /** A worker thread currently exists (it is spawned lazily, on first offload). */
  alive: boolean;
  /**
   * The crash-breaker has LATCHED: this process has stopped offloading and every
   * serialization now runs inline. Since EI-20505664003243915 this is no longer
   * permanent — the breaker re-arms itself; `reArmInMs` says when the next
   * half-open probe is admitted.
   *
   * ⚠ Do NOT alert on this field alone: `disabled:false` is an ABSENCE of bad
   * news, not evidence the offload works. Read `verdict`.
   */
  disabled: boolean;
  pendingCount: number;
  /** Batch size at/above which work is offloaded (for reading the two counts). */
  minItems: number;
  keepAlive: boolean;
  /** Crashes since the last request the worker actually served (breaker trips at 3). */
  consecutiveCrashes: number;
  /**
   * Requests the worker thread has actually SERVED — the only positive signal
   * here, and the one the reporting item asked for: it proves worker-served
   * requests RESUME rather than merely that a latch was cleared.
   */
  servedByWorker: number;
  /** Offload-ELIGIBLE requests that ran inline anyway (small batches excluded). */
  eligibleFallbacks: number;
  /** Message of the most recent worker crash, or null if none this process. */
  lastCrashError: string | null;
  /** Breaker closures earned by a served probe (NOT by a restart). */
  reArms: number;
  /** Half-open probes that crashed; each doubles the next cooldown. */
  reArmFailures: number;
  /** ms until the next half-open probe; null when the breaker is closed. */
  reArmInMs: number | null;
  /**
   * The reading `disabled` cannot give — 'serving' | 'idle-unproven' |
   * 'silently-falling-back' | 'disabled'. The middle two BOTH report
   * `disabled:false`, and telling them apart is the whole point.
   */
  verdict: CpuWorkerVerdict;
}

/**
 * WI-37696: the CPU-offload crash-breaker, made observable.
 *
 * `cpu-task-worker.ts` exists to keep large JSON serialization off the main
 * thread — inline it costs 30-50ms/tick of event-loop lag. It also has a sync
 * fallback, and that combination is what makes its breaker dangerous: when
 * `disabled` latches, the process keeps emitting BYTE-IDENTICAL responses with
 * no error, no log line and no exit code. The offload simply goes away —
 * permanently, and re-introducing exactly the lag the module was written to
 * remove. "Silent + permanent" is strictly harder to triage than "loud +
 * intermittent", and until this wiring NOTHING read `getCpuWorkerState()` at
 * all (its own doc comment claimed this endpoint and the loop-monitor
 * dashboard; neither actually called it).
 *
 * Answered for THIS PROCESS on purpose. The state is module-global to the host
 * that runs the worker, so only the host serving this request can report it —
 * and `cpu-task-worker` is genuinely loaded here (`rest-query.ts`,
 * `sync-read-audit.ts`). The SIBLING breakers in `@papercusp/memory` and
 * `@papercusp/rerank` are deliberately NOT reported here: those workers spawn in
 * the embed-sidecar process, so importing them into this handler would load a
 * module this host never uses and report a pristine `disabled: false` — a false
 * all-clear, which is a worse outcome than no signal. They are surfaced by the
 * sidecar's own `/healthz`.
 *
 * Report-only, exactly like `readLoopLag` above: an offload that fell back is
 * DEGRADED, not unserviceable. Gating readiness on it would hand a supervisor a
 * reason to restart a host that is serving correct responses.
 */
export function readCpuWorker(): CpuWorkerReading {
  return getCpuWorkerState();
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
    // Synchronous, cheap (a native histogram read) — no deadline race needed.
    const loopLag = readLoopLag();
    // Same: a plain module-state snapshot, no I/O.
    const cpuWorker = readCpuWorker();

    const ready = computeDeepReadiness({
      dbosEnabled,
      dbosLaunched: dbos,
      pg: pg.status,
      memory: memory.status,
    });

    return Response.json(
      { ok: ready, ready, dbos, dbosEnabled, pg, memory, loopLag, cpuWorker, ts: new Date().toISOString() },
      { status: ready ? 200 : 503 },
    );
  },
});
