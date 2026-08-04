/**
 * event-loop-sentinel.worker.ts — the sentinel body, running on a
 * `worker_threads` Worker so it keeps ticking while the MAIN event loop is
 * blocked. Started by `event-loop-sentinel-host.ts`; the decision itself lives
 * in the pure `event-loop-sentinel.ts`.
 *
 * ## Three measured facts this file is built on
 *
 * All three were verified empirically (2026-08-04, EI-19465075959589134) rather
 * than assumed, because each one silently breaks the feature if wrong.
 *
 * 1. **A worker keeps running while the main thread spins.** Probe: main thread
 *    blocked 3000 ms; the worker observed the freeze and decided at 600 ms of
 *    staleness. Had it been blocked too it would have reported ~3000 ms after
 *    the fact. This is the premise of the whole design.
 *
 * 2. **`console.log` from a worker DOES NOT ESCAPE a blocked main thread.** It
 *    is proxied through the parent port, so it queues behind the block — in the
 *    probe it printed only *after* the main loop was released. Since we SIGKILL,
 *    the process would die before it ever flushed: a mysterious death with no
 *    log line. `fs.writeSync(2, …)` goes straight to fd 2 and DID print during
 *    the block. **Never use console/`process.stderr.write` in this file.**
 *
 * 3. **This file may be `.ts`.** The repo convention for worker bodies is plain
 *    `.mjs` (`cpu-task-worker.script.mjs`) precisely to avoid a TypeScript
 *    transform in a worker. Measured: a Worker spawned from the tsx-run host
 *    (`npx tsx bin/hono-host.ts`) resolves and imports repo `.ts` fine. Staying
 *    in `.ts` lets this file import the SAME decider the tests exercise, which
 *    matters more here than convention — a hand-copied `.mjs` state machine
 *    could drift from the tested one, and a drifted copy of *this* logic
 *    SIGKILLs production. Spawn failure is handled fail-soft by the host, so a
 *    runtime where this does not load simply disables the sentinel.
 *
 * ## Why SIGKILL and not SIGTERM / process.exit
 *
 * - `process.exit()` in a worker exits only the WORKER thread, not the process.
 * - `SIGTERM` runs a JS handler, which is queued on the blocked main loop — it
 *   would never execute. The whole point is that the loop cannot run JS.
 * - `SIGKILL` is delivered by the kernel and needs no cooperation from the
 *   process. systemd then restarts it (a signal death is a failure, so this
 *   restarts under `Restart=on-failure` as well as `Restart=always` — the same
 *   property `memory-watchdog.ts` buys with its non-zero exit code).
 */

import { workerData, parentPort } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import {
  decideLoopSentinelAction,
  initialLoopSentinelState,
  type LoopSentinelState,
  type LoopSentinelThresholds,
} from './event-loop-sentinel';

export interface SentinelWorkerData {
  sab: SharedArrayBuffer;
  thresholds: LoopSentinelThresholds;
  observeIntervalMs: number;
  /** 'kill' arms the SIGKILL; 'observe' logs what it WOULD do and never kills. */
  mode: 'kill' | 'observe';
  /** Owning process pid — signalled on a confirmed wedge. */
  pid: number;
}

/**
 * Structured line straight to fd 2 (see fact 2 above). Shaped like the
 * memory-watchdog's lines so both watchdogs read alike in the journal.
 */
function emit(line: string, detail: Record<string, string | number | boolean>): void {
  try {
    const fields = Object.entries(detail)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : String(v)}`)
      .join(', ');
    writeSync(2, `[event-loop-sentinel] ${line} { ${fields} }\n`);
  } catch {
    /* a diagnostic must never take down the sentinel */
  }
}

const data = workerData as SentinelWorkerData;
const view = new Int32Array(data.sab);
const { thresholds, observeIntervalMs, mode, pid } = data;

let state: LoopSentinelState = initialLoopSentinelState(
  Date.now(),
  Atomics.load(view, 0),
);
/** Warn at most once per contiguous stall, so a long wedge is not a log flood. */
let warnedThisStall = false;
let acted = false;

const timer = setInterval(() => {
  if (acted) return;
  let decision;
  try {
    decision = decideLoopSentinelAction(
      state,
      { counter: Atomics.load(view, 0), nowMs: Date.now() },
      thresholds,
    );
  } catch (err) {
    // A decider throw must never kill the host, and must never spin silently.
    emit('decider threw — sentinel disabling itself (host unaffected)', {
      error: String(err).slice(0, 200),
    });
    acted = true;
    clearInterval(timer);
    return;
  }

  state = decision.state;
  const action = decision.action;

  switch (action.kind) {
    case 'ok':
    case 'grace':
      warnedThisStall = false;
      return;

    case 'warn':
      if (!warnedThisStall) {
        warnedThisStall = true;
        emit('main event loop STALLED (not yet actionable)', {
          stalenessMs: action.stalenessMs,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          consecutiveStale: action.consecutiveStale,
        });
      }
      return;

    case 'escalate-never-started':
      // The heartbeat has never moved. Cannot distinguish a loop wedged before
      // we started from a heartbeat that was never armed, so we must NOT kill —
      // that would turn a bug in this module into a host boot loop. The
      // out-of-process probe (dev:service_health, which reads unaccepted
      // connections off the LISTEN socket) owns never-started.
      acted = true;
      clearInterval(timer);
      emit(
        'heartbeat NEVER observed — NOT killing. Either the loop wedged before the sentinel started, or the heartbeat was never armed; these are indistinguishable from here. Check dev:service_health for an accept-queue wedge.',
        {
          stalenessMs: action.stalenessMs,
          consecutiveStale: action.consecutiveStale,
          pid,
        },
      );
      return;

    case 'kill': {
      acted = true;
      clearInterval(timer);
      emit(
        mode === 'kill'
          ? 'main event loop WEDGED — SIGKILLing the host (systemd will restart it)'
          : 'main event loop WEDGED — observe mode, NOT killing',
        {
          stalenessMs: action.stalenessMs,
          consecutiveStale: action.consecutiveStale,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          mode,
          pid,
          reason: action.reason,
        },
      );
      if (mode === 'kill') {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          emit('SIGKILL failed — host left running', {
            error: String(err).slice(0, 200),
            pid,
          });
        }
      }
      return;
    }
  }
}, observeIntervalMs);

// Never hold the process open on the sentinel's account.
timer.unref?.();

parentPort?.postMessage({ kind: 'ready' });
