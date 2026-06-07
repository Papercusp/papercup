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
    },
    sample: read,
  };
}
