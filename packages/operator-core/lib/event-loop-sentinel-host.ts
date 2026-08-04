/**
 * event-loop-sentinel-host.ts — main-thread half of the event-loop sentinel.
 *
 * Arms the heartbeat and spawns the watcher. The decision lives in the pure
 * `event-loop-sentinel.ts`; the watcher body in `event-loop-sentinel.worker.ts`.
 *
 * ## What this bounds, and why the memory watchdog cannot
 *
 * `papercup-staging-api.service` (:3170) blocked its event loop at
 * 2026-08-03 16:14:17Z and stayed wedged 30+ minutes, recovered only by a manual
 * restart. Every liveness signal stayed green throughout — port bound, pid
 * alive, `systemctl is-active` active, and TCP connects SUCCEEDING (the kernel
 * completes the handshake without the process). Its RSS at the sample before
 * the block was **2013 MiB against a 3200 MiB limit, and falling**, so
 * `memory-watchdog.ts` had nothing to act on and was right not to act.
 *
 * The two watchdogs are therefore complements, not alternatives:
 *
 * | failure | detector |
 * |---|---|
 * | heap grows without bound | `memory-watchdog.ts` (RSS high-water mark) |
 * | loop DEGRADED but still turning | `event-loop-lag-monitor.ts` (libuv histogram) |
 * | loop STOPPED turning, at any heap size | this |
 * | never alive since boot | `dev:service_health` accept-queue probe, out of process |
 *
 * The last row is deliberately NOT this file's job — see the `sawHeartbeat`
 * guard in the pure module for why a never-started host must not be killed
 * from in-process.
 *
 * ## Why `event-loop-lag-monitor.ts` does not already cover this
 *
 * It looks like it should: it owns a `monitorEventLoopDelay()` libuv histogram
 * and even captures a cpuprofile when p95 lag crosses its threshold. But it
 * READS that histogram from a `managedSetInterval` on the MAIN loop
 * (`event-loop-lag-monitor.ts:364`). The histogram keeps accumulating in C
 * while the loop is blocked; the reader that would report it never runs. So it
 * reports lag right up to the moment of a wedge and then goes silent — the
 * detector goes quiet exactly when the thing it watches dies.
 *
 * That is the same fate-sharing defect as the memory watchdog's sampler, and it
 * is why this sentinel had to be a separate off-thread module rather than an
 * option on the lag monitor. The two are complements: the lag monitor answers
 * "how degraded, and by what" while the loop still turns; this answers "has it
 * stopped" when it does not.
 *
 * ## Fail-soft is a hard requirement
 *
 * Every failure path here disables the sentinel and leaves the host running.
 * A watchdog that can take down the process it protects, on its own bugs, is
 * strictly worse than no watchdog — so a spawn failure, a bad config, or an
 * unsupported runtime degrades to "no sentinel", loudly, never to a crash.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import type { LoopSentinelThresholds } from './event-loop-sentinel';
import type { SentinelWorkerData } from './event-loop-sentinel.worker';

/**
 * Defaults.
 *
 * `wedgeAfterMs` is the load-bearing one: it must sit far above NORMAL loop lag
 * on this host or the sentinel becomes a random killer. Measured worst-case
 * event-loop lag here is ~3475 ms (round-3 cpuprofile captures, p95 501 ms), so
 * 20 s is ~6x the worst observed legitimate stall — and combined with
 * `observationsToAct: 3` at a 2 s cadence, a kill needs ~24 s of CONTINUOUS
 * block. That still bounds the observed 30-minute outage by ~75x.
 */
export const SENTINEL_DEFAULTS = {
  heartbeatIntervalMs: 1_000,
  observeIntervalMs: 2_000,
  wedgeAfterMs: 20_000,
  observationsToAct: 3,
  /** Boot legitimately runs long synchronous work (migrations, substrate). */
  startupGraceMs: 120_000,
} as const;

export type SentinelMode = 'kill' | 'observe' | 'off';

export interface SentinelConfig {
  mode: SentinelMode;
  thresholds: LoopSentinelThresholds;
  heartbeatIntervalMs: number;
  observeIntervalMs: number;
}

/**
 * Resolve config from the environment. Pure — takes the env, returns config, so
 * the defaults and the parsing are testable without spawning anything.
 *
 * `PAPERCUSP_EVENT_LOOP_SENTINEL`: `0`/`off`/`false` → off; `observe` → detect
 * and log but never kill; anything else (incl. unset) → armed. Armed-by-default
 * matches `memory-watchdog.ts`, which already self-recycles this same host: a
 * detector that ships disabled is one nobody ever turns on.
 *
 * `PAPERCUSP_EVENT_LOOP_SENTINEL_WEDGE_MS`: override `wedgeAfterMs`. Ignored
 * unless finite and > 0, so a typo degrades to the safe default rather than to
 * a 0 ms threshold that kills instantly.
 */
export function resolveSentinelConfig(
  env: NodeJS.ProcessEnv = process.env,
): SentinelConfig {
  const raw = (env.PAPERCUSP_EVENT_LOOP_SENTINEL ?? '').trim().toLowerCase();
  const mode: SentinelMode =
    raw === '0' || raw === 'off' || raw === 'false'
      ? 'off'
      : raw === 'observe'
        ? 'observe'
        : 'kill';

  const wedgeOverride = Number(env.PAPERCUSP_EVENT_LOOP_SENTINEL_WEDGE_MS);
  const wedgeAfterMs =
    Number.isFinite(wedgeOverride) && wedgeOverride > 0
      ? wedgeOverride
      : SENTINEL_DEFAULTS.wedgeAfterMs;

  return {
    mode,
    heartbeatIntervalMs: SENTINEL_DEFAULTS.heartbeatIntervalMs,
    observeIntervalMs: SENTINEL_DEFAULTS.observeIntervalMs,
    thresholds: {
      wedgeAfterMs,
      observationsToAct: SENTINEL_DEFAULTS.observationsToAct,
      startupGraceMs: SENTINEL_DEFAULTS.startupGraceMs,
    },
  };
}

export interface EventLoopSentinelHandle {
  /** Stop the heartbeat and terminate the watcher. */
  stop(): Promise<void>;
  /** Whether the watcher is actually running (false when off or spawn failed). */
  active(): boolean;
  /** Current heartbeat counter — diagnostics for /api/health. */
  beats(): number;
}

const INACTIVE: EventLoopSentinelHandle = {
  stop: async () => {},
  active: () => false,
  beats: () => 0,
};

function workerPath(): string {
  const here =
    typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  return resolve(dirname(here), 'event-loop-sentinel.worker.ts');
}

/**
 * Start the sentinel. Call once at host boot, AFTER the port is bound (so the
 * startup grace covers boot rather than the sentinel racing it).
 *
 * Returns an inactive handle — never throws — when disabled or when the worker
 * cannot spawn.
 */
export function startEventLoopSentinel(
  opts: {
    env?: NodeJS.ProcessEnv;
    log?: (line: string, detail: Record<string, unknown>) => void;
  } = {},
): EventLoopSentinelHandle {
  const env = opts.env ?? process.env;
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  const cfg = resolveSentinelConfig(env);
  if (cfg.mode === 'off') {
    log('[event-loop-sentinel] disabled by PAPERCUSP_EVENT_LOOP_SENTINEL', {
      value: env.PAPERCUSP_EVENT_LOOP_SENTINEL,
    });
    return INACTIVE;
  }

  // Int32Array + Atomics: the ONLY channel that works here. A postMessage
  // round-trip would need the main loop to answer, which is precisely what a
  // wedge prevents — measured: the worker's reply queued until the block ended.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);

  let worker: Worker;
  try {
    const data: SentinelWorkerData = {
      sab,
      thresholds: cfg.thresholds,
      observeIntervalMs: cfg.observeIntervalMs,
      mode: cfg.mode,
      pid: process.pid,
    };
    worker = new Worker(workerPath(), { workerData: data });
  } catch (err) {
    // Fail-soft: no sentinel is strictly better than a crashed host.
    log('[event-loop-sentinel] worker spawn FAILED — sentinel disabled, host unaffected', {
      error: String(err).slice(0, 300),
    });
    return INACTIVE;
  }

  worker.on('error', (err) => {
    log('[event-loop-sentinel] worker error — sentinel disabled, host unaffected', {
      error: String(err).slice(0, 300),
    });
  });

  worker.unref();

  // The heartbeat. `managedSetInterval` (never a bare setInterval) so it is
  // visible in schedule:inventory alongside the memory watchdog. When the loop
  // blocks this callback stops firing — which IS the signal.
  const heartbeat = managedSetInterval(
    'event-loop-sentinel-heartbeat',
    cfg.heartbeatIntervalMs,
    () => {
      Atomics.add(view, 0, 1);
    },
    { category: 'watchdog' },
  );

  log('[event-loop-sentinel] armed', {
    mode: cfg.mode,
    wedgeAfterMs: cfg.thresholds.wedgeAfterMs,
    observationsToAct: cfg.thresholds.observationsToAct,
    startupGraceMs: cfg.thresholds.startupGraceMs,
    heartbeatIntervalMs: cfg.heartbeatIntervalMs,
    observeIntervalMs: cfg.observeIntervalMs,
  });

  return {
    async stop() {
      heartbeat.stop();
      try {
        await worker.terminate();
      } catch {
        /* noop */
      }
    },
    active: () => true,
    beats: () => Atomics.load(view, 0),
  };
}
