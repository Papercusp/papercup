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

import { setFlagsFromString } from 'node:v8';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { runInNewContext } from 'node:vm';
import { backgroundWorkersEnabled } from './background-workers';

/**
 * Default RSS high-water mark (MiB), by host ROLE — used when
 * `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB` is not set explicitly.
 *
 * The original single 3200 default was sized for a request-serving host. The
 * dedicated BACKGROUND primary (the bg-host, `PAPERCUSP_BACKGROUND_WORKERS=1`)
 * is a different animal: it boots the full hyperbee substrate (~25 harnesses)
 * AND drives DBOS catch-up recovery, so its real working set is ~3.8 GB
 * baseline + ~108 MB/harness (observed ~5 GB). 3200 trips within minutes there
 * and the host recycles in a loop — and pre-EI-1613 the exit-0 recycle left it
 * DEAD under `Restart=on-failure`, freezing the whole routine engine (EI-1613;
 * the same class the dev-api host hit in EI-127, patched there with a 12288
 * systemd drop-in). A request-only worker (BG=0 — the :3070 cluster workers,
 * the :3170 staging operator) does NOT boot the substrate and stays light.
 */
export const MEMORY_WATCHDOG_LIMIT_MB_REQUEST = 3200;
export const MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND = 12288;

/**
 * The RSS high-water mark (MiB) THIS process should recycle at. An explicit
 * `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB` always wins; otherwise the default is
 * role-aware (see above), so a FRESH box's bg-host is correct WITHOUT a
 * box-local systemd drop-in (EI-1613 — the durable fix for the 3200-too-low
 * bug that was only ever papered over per-box).
 */
export function resolveMemoryWatchdogLimitMb(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env.PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return backgroundWorkersEnabled(env)
    ? MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND
    : MEMORY_WATCHDOG_LIMIT_MB_REQUEST;
}

export interface MemoryWatchdogOpts {
  /** RSS high-water mark in MiB. Crossing it for `tripsToRecycle` samples → recycle. Default 3200. */
  rssLimitMb?: number;
  /** Soft warn threshold in MiB — log a structured gauge line above this (observability). Default = 0.75 × rssLimitMb. */
  warnMb?: number;
  /** Sample cadence (ms). Default 30_000. */
  intervalMs?: number;
  /** Consecutive over-limit samples before recycling (debounce). Default 2. */
  tripsToRecycle?: number;
  /**
   * PROACTIVE-GC threshold (MiB) — the ROOT bg-host-freeze fix. When RSS crosses
   * this (well BELOW `rssLimitMb`) and `--expose-gc` made `global.gc` available,
   * run ONE forced full GC to reclaim retained heap BEFORE V8's own
   * heap-pressure GC kicks in. Why this matters: `NODE_OPTIONS` here carries
   * `--max-old-space-size=131072` (128 GB — a box-wide setting for the 251 GB
   * host), which DEFEATS V8's heap-limit-paced GC: the old generation grows into
   * the multi-GB regime where a single mark-compact pause stalls the SINGLE event
   * loop for seconds-to-minutes. On the BACKGROUND primary (the routine ticker)
   * that stall IS the "bg-host frozen ~27 min, ticker stops firing, watchdog
   * restarts a healthy host" incident (EI-2186 spawn-reclaim massacre). A cheap
   * forced GC at ~60% of the recycle limit keeps the live heap small enough that
   * V8's pauses stay sub-100ms, so the loop never freezes. Default = 0.6 ×
   * rssLimitMb. Set <= 0 (or unset `global.gc`) to disable. The GC itself is
   * debounced (`gcCooldownMs`) so a host parked above the threshold doesn't GC
   * every tick. This is the cause-side fix; the recycle is the last-resort
   * backstop, the watchdog the last-last-resort.
   */
  proactiveGcMb?: number;
  /** Minimum gap between forced proactive GCs (ms). Default 120_000 (2 min). */
  gcCooldownMs?: number;
  /** Injectable forced-GC seam (tests). Defaults to `global.gc` when `--expose-gc`. */
  forceGc?: (() => void) | null;
  /** Structured log sink. Default console.warn. */
  log?: (line: string, detail: Record<string, number>) => void;
  /**
   * Exit code the default recycle uses. NON-ZERO (default 75 = EX_TEMPFAIL) so a
   * recycle restarts under BOTH `Restart=always` AND `Restart=on-failure` — a unit
   * that ships `on-failure` (as the bg-host did) must still self-restart, else the
   * recycle exits 0 and the host stays dead (EI-1613, R4-1). Override in tests.
   */
  recycleExitCode?: number;
  /**
   * What to do when the high-water mark trips. Default: log loudly then
   * `process.exit(recycleExitCode)` after a short flush delay (systemd restarts).
   * A real host should inject `gracefulHostRecycle` (host-recycle.ts) so in-flight
   * HTTP drains AND the P2P substrate handles close before exit (audit P-002,
   * EI-127) — hono-host.ts does.
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
 * Resolve a forced full-GC hook for the proactive-GC freeze fix, WITHOUT requiring
 * `--expose-gc` in NODE_OPTIONS. Order: an already-exposed `global.gc`, else
 * runtime-enable it via `v8.setFlagsFromString('--expose-gc')` and grab the `gc`
 * binding through a fresh VM context. Returns null if neither works (never throws).
 * Cached null/fn is fine — the binding is stable for the process lifetime.
 */
export function resolveForceGc(): (() => void) | null {
  const exposed = (globalThis as { gc?: () => void }).gc;
  if (typeof exposed === 'function') return exposed;
  try {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    return typeof gc === 'function' ? (gc as () => void) : null;
  } catch {
    return null;
  }
}

/**
 * Start the memory watchdog. Returns a handle; the timer is `unref`'d so it
 * never keeps the process alive on its own. Call once at host boot.
 */
export function startMemoryWatchdog(opts: MemoryWatchdogOpts = {}): MemoryWatchdogHandle {
  const rssLimitMb = opts.rssLimitMb ?? 3200;
  const warnMb = opts.warnMb ?? Math.round(rssLimitMb * 0.75);
  const intervalMs = opts.intervalMs ?? 30_000;
  const tripsToRecycle = Math.max(1, opts.tripsToRecycle ?? 2);
  // Proactive-GC config (the root bg-host-freeze fix). Default threshold = 60% of
  // the recycle limit so a controlled GC runs in the safe band, long before the
  // GC-stall zone or the recycle. Disabled if the threshold is non-positive OR no
  // forced-GC hook is available (no `--expose-gc`).
  const proactiveGcMb = opts.proactiveGcMb ?? Math.round(rssLimitMb * 0.6);
  const gcCooldownMs = Math.max(0, opts.gcCooldownMs ?? 120_000);
  // Resolve a forced-GC hook, fresh-box-correct (no dependency on `--expose-gc`
  // being in NODE_OPTIONS): prefer an injected seam, else `global.gc` if exposed,
  // else RUNTIME-enable it via `v8.setFlagsFromString('--expose-gc')` +
  // `vm.runInNewContext('gc')`. The runtime path makes the freeze fix durable on
  // any box (the production box happens to carry `--expose-gc` in a box-wide
  // ~/.profile, but a fresh deploy must not silently lose proactive GC).
  const forceGc = opts.forceGc !== undefined ? opts.forceGc : resolveForceGc();
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  const recycleExitCode = opts.recycleExitCode ?? 75;
  const onTrip =
    opts.onTrip ??
    ((detail) => {
      log('[memory-watchdog] RSS high-water mark tripped — recycling host (systemd will restart)', {
        rssMb: detail.rssMb,
        rssLimitMb: detail.rssLimitMb,
        recycleExitCode,
      });
      // Let the log line flush, then exit NON-ZERO so systemd restarts under
      // Restart=on-failure as well as Restart=always (EI-1613, R4-1) — RestartSec
      // (~5 s) brings up a fresh low-RSS process.
      setTimeout(() => process.exit(recycleExitCode), 250).unref?.();
    });

  let overCount = 0;
  let recycled = false;
  let lastGcAt = 0;

  const rssMb = () => bytesToMb(process.memoryUsage().rss);

  const timer = managedSetInterval('memory-watchdog', intervalMs, () => {
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
    // PROACTIVE GC (root freeze fix) — runs in the SAFE band (≥ proactiveGcMb, <
    // rssLimitMb) on a cooldown. A forced full GC here keeps the live heap out of
    // the multi-GB old-gen regime where a mark-compact pause freezes the event
    // loop (the bg-host ticker freeze). Cheap relative to a stall: a sub-second GC
    // every few minutes vs a multi-minute loop freeze + watchdog restart storm.
    // Skipped once over the recycle limit (the recycle owns that case) and when
    // disabled (no `--expose-gc`, or proactiveGcMb <= 0).
    if (
      forceGc &&
      proactiveGcMb > 0 &&
      rss >= proactiveGcMb &&
      rss < rssLimitMb &&
      Date.now() - lastGcAt >= gcCooldownMs
    ) {
      lastGcAt = Date.now();
      const before = rss;
      try {
        forceGc();
      } catch {
        /* a forced GC must never crash the watchdog */
      }
      const after = rssMb();
      log('[memory-watchdog] proactive GC (heap kept out of the stall zone)', {
        rssMbBefore: before,
        rssMbAfter: after,
        reclaimedMb: Math.max(0, before - after),
        proactiveGcMb,
        rssLimitMb,
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
  }, { category: 'watchdog' });

  return {
    stop() {
      timer.stop();
    },
    rssMb,
  };
}
