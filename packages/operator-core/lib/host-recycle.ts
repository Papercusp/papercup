/**
 * host-recycle.ts — drain-then-exit recycle for the long-running Hono host.
 *
 * The memory-watchdog's onTrip must not bare-`process.exit()`: every booted
 * harness substrate handle holds a Hypercore, a Hyperswarm peer socket, and
 * close-hooks (PG LISTEN connection + outbox-drain timer). Abandoning them on
 * exit leaves swarm sockets lingering until peers time out and LISTEN slots
 * claimed into the next process's window — an EI-127 RSS/resource-leak
 * contributor (audit P-002).
 *
 * `gracefulHostRecycle` tears down the substrate CONCURRENTLY with the HTTP
 * drain (`server.close` waits for in-flight requests), exits only after BOTH
 * complete, and hard-exits after `hardExitMs` if either hangs.
 *
 * WI-3795: a cluster-wide restart/deploy SIGTERMs every worker in the cgroup
 * at once (`[cluster] SIGTERM — draining N worker(s)`); each independently
 * starts this same substrate teardown. Live evidence (2026-07-10, journalctl
 * on papercup-dev-api.service): dozens of these concurrent teardowns crash
 * with `terminate called after throwing an instance of 'Napi::Error'` →
 * SIGABRT, specifically when they land during a host event-loop-lag spike
 * (p99 in the hundreds-of-ms to low-seconds at the moment of the crash burst).
 * That failure mode is a raw C++ exception escaping a native P2P-substrate
 * binding's background thread — it happens BELOW the JS layer, so no
 * try/catch or Promise.race here can catch or bound it once the native close
 * has started (the crash always self-heals via cluster/systemd respawn — no
 * sustained outage — but it's needless SIGABRT churn during every
 * high-load restart). The only lever available at this layer is to not
 * START the risky native close in the first place when we already know the
 * loop is under pressure: `closeSubstrate()` is skipped (not merely bounded)
 * whenever `isSaturated()` reads true at drain time, trading a (pre-existing,
 * already-accepted per this file's own header) socket-lingers-until-peer-
 * timeout cost for avoiding the crash entirely. A full native-level fix needs
 * an attached debugger / core dump on a live repro, which is out of scope for
 * a headless fix — tracked as a follow-up.
 *
 * WI-3848 (a peer's live crash sample) showed this can fire at p95 as low as
 * ~400-700ms — BELOW event-loop-lag-monitor's default 600ms 'critical'
 * threshold for some of that range. So `isSaturated` defaults to
 * `isLoopElevated` (the 'elevated' OR 'critical' band, default >=120ms p95),
 * not the narrower `isLoopSaturated` ('critical' only, >=600ms) — the skip is
 * cheap and the observed crash range starts well below 'critical'.
 */

import { closeAllBootedHarnesses } from './sync/hyperbee/boot-all';
import { markShuttingDown } from './shutdown-state';
import { isLoopElevated } from './event-loop-lag-monitor';

/** The slice of `@hono/node-server`'s server this helper needs. */
export interface RecycleServerLike {
  close?: (cb?: () => void) => void;
}

export interface GracefulRecycleOpts {
  server: RecycleServerLike;
  /** Hard-exit backstop if the drain or the substrate teardown hangs. Default 8000. */
  hardExitMs?: number;
  /**
   * Exit code on recycle. NON-ZERO (default 75 = EX_TEMPFAIL) so the host restarts
   * under `Restart=on-failure` as well as `Restart=always` (EI-1613, R4-1). The
   * SIGTERM/deploy drain path is separate and still exits 0 (an intentional stop).
   */
  recycleExitCode?: number;
  /** Test seam — defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Test seam — defaults to `closeAllBootedHarnesses`. */
  closeSubstrate?: () => Promise<unknown>;
  /**
   * Test seam — defaults to `isLoopElevated` (event-loop-lag-monitor.ts): the
   * 'elevated' OR 'critical' band (default p95 >=120ms), NOT the narrower
   * 'critical'-only `isLoopSaturated` (default >=600ms). WI-3795/WI-3848: when
   * the loop is ALREADY under pressure at the moment the drain starts, skip
   * attempting the substrate close entirely (see the WI-3795/WI-3848 note
   * below `closeSubstrate` in this file's header doc — live crash evidence
   * showed this can fire below the 'critical' threshold).
   */
  isSaturated?: () => boolean;
}

/**
 * Stop accepting new connections, drain in-flight HTTP, tear down the P2P
 * substrate, then exit with `recycleExitCode` (NON-ZERO, default 75) so systemd
 * restarts the host under `Restart=on-failure` as well as `Restart=always`
 * (EI-1613, R4-1). Never throws; never exits more than once.
 */
export function gracefulHostRecycle(opts: GracefulRecycleOpts): void {
  const hardExitMs = opts.hardExitMs ?? 8000;
  const recycleExitCode = opts.recycleExitCode ?? 75;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const closeSubstrate = opts.closeSubstrate ?? closeAllBootedHarnesses;
  const isSaturated = opts.isSaturated ?? isLoopElevated;

  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const hardExit = setTimeout(() => exitOnce(recycleExitCode), hardExitMs);
  (hardExit as { unref?: () => void }).unref?.();

  // Substrate teardown starts immediately, concurrent with the HTTP drain —
  // UNLESS the loop is already under pressure (WI-3795/WI-3848): starting the
  // native P2P-substrate close under that condition is what triggers the
  // Napi::Error/SIGABRT crash (observed as low as p95 ~400-700ms, below the
  // 'critical' band), and a bounded/caught wrapper here can't prevent it (the
  // throw escapes below the JS layer). Skipping the attempt trades the same
  // pre-existing "sockets linger until peer timeout" cost this file already
  // accepts for a clean exit instead of a crash.
  const substrateDown = (async () => {
    if (isSaturated()) {
      console.warn(
        '[host-recycle] event loop under pressure at drain time — skipping substrate teardown to avoid the WI-3795/WI-3848 Napi::Error/SIGABRT race (sockets will linger until peer timeout, same as an abandoned-on-crash exit)',
      );
      return;
    }
    try {
      await closeSubstrate();
    } catch {
      // best-effort: a teardown failure must never block the recycle
    }
  })();

  try {
    if (typeof opts.server.close === 'function') {
      opts.server.close(() => {
        void substrateDown.then(() => {
          clearTimeout(hardExit);
          exitOnce(recycleExitCode);
        });
      });
    }
    // No close fn → nothing drains HTTP; the hard-exit backstop fires after
    // the substrate teardown window.
  } catch {
    void substrateDown.then(() => exitOnce(recycleExitCode));
  }
}

export interface GracefulShutdownOpts {
  server: RecycleServerLike;
  /** Signals that trigger the drain. Default ['SIGTERM', 'SIGINT']. */
  signals?: readonly NodeJS.Signals[];
  /** Test seam — defaults to `process.on`. */
  on?: (sig: NodeJS.Signals, cb: () => void) => void;
  /** Test seam — forwarded to gracefulHostRecycle (defaults to process.exit). */
  exit?: (code: number) => void;
  /** Test seam — forwarded to gracefulHostRecycle. */
  closeSubstrate?: () => Promise<unknown>;
  /** Test seam — forwarded to gracefulHostRecycle (WI-3795 saturated-skip check). */
  isSaturated?: () => boolean;
  /** Forwarded to gracefulHostRecycle (hard-exit backstop). */
  hardExitMs?: number;
  /** Test seam — defaults to console.log. */
  log?: (msg: string) => void;
}

/**
 * Install the graceful-shutdown drain for the HTTP-serving process (the
 * single-process host + each cluster worker). On the FIRST SIGTERM/SIGINT it
 * stops accepting new connections, drains in-flight HTTP, tears down the
 * substrate, then exits 0 — an INTENTIONAL stop (deploy / `systemctl restart`),
 * distinct from the non-zero memory-watchdog recycle code.
 *
 * Without this, Node's default SIGTERM is an immediate exit that severs in-flight
 * requests, so a deploy restart 502s anything mid-flight (infra-fail-fast P-017).
 * Idempotent: a second signal while draining is ignored (the bounded
 * gracefulHostRecycle owns the hard-exit backstop). Best-effort — never throws.
 */
export function installGracefulShutdown(opts: GracefulShutdownOpts): void {
  const on = opts.on ?? ((sig: NodeJS.Signals, cb: () => void) => void process.on(sig, cb));
  const signals = opts.signals ?? (['SIGTERM', 'SIGINT'] as const);
  const log = opts.log ?? ((m: string) => console.log(m));

  let draining = false;
  const drainAndExit = (sig: NodeJS.Signals): void => {
    if (draining) return;
    draining = true;
    // P-005: announce the drain process-wide BEFORE teardown so background work
    // that consults isShuttingDown() (the auto-implement dispatch loop) stops
    // STARTING new minutes-long workers that this drain would SIGKILL mid-fix.
    markShuttingDown();
    log(`[hono-host] ${sig} — draining in-flight HTTP + substrate, then exiting (pid=${process.pid})`);
    gracefulHostRecycle({
      server: opts.server,
      recycleExitCode: 0, // intentional stop, not the non-zero recycle code
      exit: opts.exit,
      closeSubstrate: opts.closeSubstrate,
      isSaturated: opts.isSaturated,
      hardExitMs: opts.hardExitMs,
    });
  };

  for (const sig of signals) on(sig, () => drainAndExit(sig));
}
