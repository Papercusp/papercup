/**
 * event-loop-lag-monitor.ts — cheap, always-on event-loop-lag gauge
 * (EI-79 observability). Booted by the Hono host; also the central SLO
 * instrument of the p2p-perf suite (`lib/sync/hyperbee/perf/`), which is why
 * it lives in operator-core rather than apps/operator
 * (p2p-performance-suite-2026-06-07 P-007 / D-003).
 *
 * EI-79 was a forensic slog precisely because nothing on the host reported the
 * one number that explained it: the event loop was carrying sustained CPU work
 * (a 1Hz full-history hyperbee re-merge), so every `await` hop paid the loop
 * delay and hop-heavy agent-mcp routes degraded to 12-30s while `/api/health`
 * (≈2 hops) stayed fast. A standing lag gauge makes that self-evident next time.
 *
 * Implementation: `perf_hooks.monitorEventLoopDelay()` is a native libuv
 * histogram timer — it samples loop delay in C with negligible JS overhead (far
 * cheaper than a `setInterval` drift probe, which itself competes for the loop).
 * We read + reset it on a slow cadence and log a single structured line ONLY
 * when p95 lag crosses a threshold, so a healthy host is silent.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface LagMonitorOpts {
  /** How often to sample + evaluate the histogram (ms). Default 10_000. */
  intervalMs?: number;
  /** Log a warning when p95 loop lag (ms) over the window exceeds this. Default 100. */
  warnP95Ms?: number;
  /** Sink for the structured warning line. Default console.warn. */
  log?: (line: string, detail: Record<string, number>) => void;
}

export interface LagMonitorHandle {
  /** Stop sampling (clears the timer + disables the histogram). */
  stop(): void;
  /** Read the current window's stats without resetting (for an endpoint/test). */
  sample(): { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
}

export type LoopPressure = 'ok' | 'elevated' | 'critical';

// P5-1 (operator-scalability-event-loop-2026-06-16): the running monitor's live
// read fn, published module-globally so the Layer-2 feedback governor (background
// load-shedding + spawn admission) can read loop pressure WITHOUT its own probe.
// Null until the host boots the monitor (e.g. a request-only worker that never
// started one) — callers treat null as 'ok' (no signal ⇒ don't shed).
let _liveRead: (() => { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }) | null = null;

/** p95 loop-delay (ms) thresholds for the pressure bands. Env-tunable so a small
 *  host can be stricter. elevated ⇒ start widening cadences; critical ⇒ shed. */
const ELEVATED_P95_MS = Math.max(1, Number(process.env.PAPERCUSP_LOOP_ELEVATED_MS) || 120);
const CRITICAL_P95_MS = Math.max(
  ELEVATED_P95_MS + 1,
  Number(process.env.PAPERCUSP_LOOP_CRITICAL_MS) || 600,
);

/** The live loop-delay sample (current partial window), or null if no monitor. */
export function currentLoopLag(): { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number } | null {
  return _liveRead ? _liveRead() : null;
}

/** Pure band classification from a p95 loop-delay (ms). Exported for tests. */
export function classifyLoopPressure(
  p95Ms: number,
  elevatedMs: number = ELEVATED_P95_MS,
  criticalMs: number = CRITICAL_P95_MS,
): LoopPressure {
  if (!Number.isFinite(p95Ms)) return 'ok';
  if (p95Ms >= criticalMs) return 'critical';
  if (p95Ms >= elevatedMs) return 'elevated';
  return 'ok';
}

/** Current loop pressure band from the live p95. 'ok' when no monitor is running
 *  (absence of signal must never cause shedding). */
export function loopPressure(): LoopPressure {
  const s = _liveRead?.();
  if (!s) return 'ok';
  return classifyLoopPressure(s.p95Ms);
}

/** True when the request loop is critically saturated — admission gates + heavy
 *  background ticks should back off this cycle. */
export function isLoopSaturated(): boolean {
  return loopPressure() === 'critical';
}

/**
 * Start the event-loop-lag monitor. Returns a handle; the underlying timer is
 * `unref`'d so it never keeps the process alive on its own. Idempotent enough
 * for one-per-process use — call once at host boot.
 */
export function startEventLoopLagMonitor(opts: LagMonitorOpts = {}): LagMonitorHandle {
  const intervalMs = opts.intervalMs ?? 10_000;
  const warnP95Ms = opts.warnP95Ms ?? 100;
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  // resolution: histogram bucket granularity (ms). 20ms is plenty for a
  // "the loop is blocked" gauge and keeps the timer overhead trivial.
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  const ns2ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
  const read = () => ({
    p50Ms: ns2ms(h.percentile(50)),
    p95Ms: ns2ms(h.percentile(95)),
    p99Ms: ns2ms(h.percentile(99)),
    maxMs: ns2ms(h.max),
  });
  // P5-1: publish the live read so loopPressure()/isLoopSaturated() work fleet-wide.
  _liveRead = read;

  const timer = setInterval(() => {
    const s = read();
    if (s.p95Ms >= warnP95Ms) {
      log('[event-loop-lag] high loop delay — host is CPU-bound on the main thread', {
        p50Ms: s.p50Ms,
        p95Ms: s.p95Ms,
        p99Ms: s.p99Ms,
        maxMs: s.maxMs,
        windowMs: intervalMs,
      });
    }
    // Reset so each window is independent (a one-off spike doesn't pin the
    // gauge high forever).
    h.reset();
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop() {
      clearInterval(timer);
      h.disable();
      if (_liveRead === read) _liveRead = null;
    },
    sample: read,
  };
}
