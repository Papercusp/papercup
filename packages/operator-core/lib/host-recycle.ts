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
 */

import { closeAllBootedHarnesses } from './sync/hyperbee/boot-all';

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

  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const hardExit = setTimeout(() => exitOnce(recycleExitCode), hardExitMs);
  (hardExit as { unref?: () => void }).unref?.();

  // Substrate teardown starts immediately, concurrent with the HTTP drain.
  const substrateDown = (async () => {
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
