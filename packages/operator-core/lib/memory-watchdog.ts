/**
 * memory-watchdog.ts — bounded-RSS self-recycle for the long-running Hono host.
 *
 * The :3070 operator (`bin/hono-host.ts`, `tsx`, node, `Restart=always`) leaks
 * retained heap under fleet load — observed 2026-06-07 growing ~0.2 GB/min with
 * no plateau (0.76 GB fresh → 4.5 GB in ~30 min). Node has no heap cap here, so
 * V8 lets the heap balloon; past ~4 GB the GC pauses stall the single-threaded
 * event loop for seconds, and THAT is what intermittently broke everything that
 * night — MCP handshakes succeeded-then-dropped, `/api/harness/:slug/invoke`
 * returned empty, spawned-agent MCP mounts raced and failed, even `/api/health`
 * flipped between 10 ms and timeout. The event-loop-lag gauge (EI-79) reports
 * the *symptom*; this bounds the *cause*.
 *
 * Mitigation (not a leak fix — that's a separate profiling task): poll RSS on a
 * slow cadence and, when it crosses a high-water mark for N consecutive samples
 * (debounced against a transient spike), GRACEFULLY recycle — drain in-flight
 * work, then exit; systemd `Restart=always` reboots a fresh low-RSS process in
 * ~5 s. A bounded recycle every ~30 min beats a slow event-loop death. The
 * default high-water mark (3.2 GB) sits comfortably below the ~4 GB stall zone
 * yet high enough to give real uptime between recycles.
 *
 * Standard production pattern (PM2 `max_memory_restart`, k8s memory limits) —
 * here in-process so it can drain HTTP gracefully before exiting.
 */

export interface MemoryWatchdogOpts {
  /** RSS high-water mark in MiB. Crossing it for `tripsToRecycle` samples → recycle. Default 3200. */
  rssLimitMb?: number;
  /** Soft warn threshold in MiB — log a structured gauge line above this (observability). Default = 0.75 × rssLimitMb. */
  warnMb?: number;
  /** Sample cadence (ms). Default 30_000. */
  intervalMs?: number;
  /** Consecutive over-limit samples before recycling (debounce). Default 2. */
  tripsToRecycle?: number;
  /** Structured log sink. Default console.warn. */
  log?: (line: string, detail: Record<string, number>) => void;
  /**
   * What to do when the high-water mark trips. Default: log loudly then
   * `process.exit(0)` after a short flush delay (systemd Restart=always
   * recycles). A real host should inject `gracefulHostRecycle` (host-recycle.ts)
   * so in-flight HTTP drains AND the P2P substrate handles close before exit
   * (audit P-002, EI-127) — hono-host.ts does.
   */
  onTrip?: (detail: { rssMb: number; rssLimitMb: number }) => void;
}

export interface MemoryWatchdogHandle {
  /** Stop sampling (clears the timer). */
  stop(): void;
  /** Current RSS in MiB (for an endpoint/test). */
  rssMb(): number;
}

const bytesToMb = (b: number) => Math.round(b / (1024 * 1024));

/**
 * Start the memory watchdog. Returns a handle; the timer is `unref`'d so it
 * never keeps the process alive on its own. Call once at host boot.
 */
export function startMemoryWatchdog(opts: MemoryWatchdogOpts = {}): MemoryWatchdogHandle {
  const rssLimitMb = opts.rssLimitMb ?? 3200;
  const warnMb = opts.warnMb ?? Math.round(rssLimitMb * 0.75);
  const intervalMs = opts.intervalMs ?? 30_000;
  const tripsToRecycle = Math.max(1, opts.tripsToRecycle ?? 2);
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  const onTrip =
    opts.onTrip ??
    ((detail) => {
      log('[memory-watchdog] RSS high-water mark tripped — recycling host (systemd will restart)', {
        rssMb: detail.rssMb,
        rssLimitMb: detail.rssLimitMb,
      });
      // Let the log line flush, then exit cleanly. Restart=always brings up a
      // fresh low-RSS process in RestartSec (~5 s).
      setTimeout(() => process.exit(0), 250).unref?.();
    });

  let overCount = 0;
  let recycled = false;

  const rssMb = () => bytesToMb(process.memoryUsage().rss);

  const timer = setInterval(() => {
    if (recycled) return;
    const rss = rssMb();
    if (rss >= warnMb) {
      log('[memory-watchdog] RSS above soft threshold', {
        rssMb: rss,
        warnMb,
        rssLimitMb,
        overCount,
      });
    }
    if (rss >= rssLimitMb) {
      overCount += 1;
      if (overCount >= tripsToRecycle) {
        recycled = true;
        onTrip({ rssMb: rss, rssLimitMb });
      }
    } else {
      // Reset the debounce on any sample back under the limit (a transient
      // spike shouldn't recycle a host that GC'd back down).
      overCount = 0;
    }
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
    rssMb,
  };
}
