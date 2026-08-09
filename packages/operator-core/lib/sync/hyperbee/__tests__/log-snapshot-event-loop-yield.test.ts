import { describe, it, expect } from 'vitest';
import { produceLogSnapshot, SNAPSHOT_READ_CONCURRENCY } from '../log-snapshot';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * P-014 half 3 (2026-08-09) — `produceLogSnapshot` must YIELD TO THE EVENT LOOP while it
 * reads, so timer-driven work in the same process keeps running.
 *
 * `await` is not a yield to the event loop; it is a yield to the MICROTASK queue. A block
 * already resident in the store resolves within the current tick, so a loop of awaits over
 * a WARM local log drains microtasks forever and the loop never reaches its TIMER phase.
 * Every `setInterval`/`setTimeout` in the process is then starved for the whole read.
 *
 * That is not a latency nit here — it is what made the operation UNCOMPLETABLE. Measured on
 * the live 461,475-block own log 2026-08-09: a head-snapshot ran 455s and
 * `harness_shared.routines` recorded ZERO fires for the entire window (last 11:45, next
 * 11:55). `bghost-watchdog` restarts the unit when the routines ticker is >240s stale while
 * active, so it correctly judged the ticker frozen and killed the snapshot at 455s. The
 * snapshot was killing its own host, which is why neither a longer client timeout nor a
 * longer route timeout could ever have closed it.
 *
 * THE INSTRUMENT. A `setTimeout(…, 0)` armed before the read fires from the TIMER phase, so
 * it can only run if the read reaches that phase. Whether it lands DURING or AFTER the read
 * is therefore a direct, wall-clock-independent read of "did this operation yield". No
 * sleeping, no timing thresholds, nothing load-dependent.
 *
 * THE CONTROL (`foldWithoutYielding`, below) is permanently resident and deliberately wrong:
 * the same loop with the yield removed. The same instrument must report it STARVED. Without
 * that, a green subject test would be equally consistent with an instrument that cannot
 * detect starvation at all — and this file's whole claim is that it can.
 */

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}

/**
 * A WARM own-log: every `get` resolves inside the current tick — no timer, no I/O. This is
 * the condition that produces the bug (a fully-cached local hypercore), and the condition
 * `instrumentedLog` in the read-pipelining suite deliberately does NOT reproduce, because
 * its `setTimeout` per read yields to the timer phase on its own.
 */
function warmLog(ops: PeerLogOp[]): OwnLog {
  const appended: PeerLogOp[] = [...ops];
  return {
    get keyHex() {
      return 'k'.repeat(64);
    },
    get length() {
      return appended.length;
    },
    async append(op: PeerLogOp) {
      appended.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      appended.push(...batch);
    },
    async get(i: number) {
      return appended[i] ?? null;
    },
  } as OwnLog;
}

/** Enough ops to span several read windows, so a yield lands genuinely MID-READ. */
function corpus(n: number): PeerLogOp[] {
  return Array.from({ length: n }, (_, i) => put('t', `k${i}`, { i }, i + 1));
}

const OP_COUNT = SNAPSHOT_READ_CONCURRENCY * 3;

/**
 * Arms a timer-phase probe, runs `op`, and reports whether the timer got a turn WHILE `op`
 * was still running. `'during'` = the operation yielded; `'after'` = it starved the loop.
 */
async function observeYield(op: () => Promise<unknown>): Promise<'during' | 'after'> {
  let finished = false;
  let landed: 'during' | 'after' | null = null;
  const armed = new Promise<void>((resolve) => {
    setTimeout(() => {
      landed = finished ? 'after' : 'during';
      resolve();
    }, 0);
  });
  await op();
  finished = true;
  await armed;
  // `landed` is assigned in the timer callback that `armed` resolves from.
  return landed as unknown as 'during' | 'after';
}

/**
 * THE CONTROL — the pre-fix shape of the read loop in `produceLogSnapshot`, kept here
 * permanently so the instrument above is proven able to SEE starvation. If this ever starts
 * reporting `'during'`, the instrument has stopped working and the subject test below is
 * no longer evidence of anything.
 */
async function foldWithoutYielding(ownLog: OwnLog, upTo: number): Promise<number> {
  let seen = 0;
  for (let start = 0; start < upTo; start += SNAPSHOT_READ_CONCURRENCY) {
    const end = Math.min(start + SNAPSHOT_READ_CONCURRENCY, upTo);
    const window = await Promise.all(
      Array.from({ length: end - start }, (_, k) => ownLog.get(start + k)),
    );
    for (const op of window) if (op) seen += 1;
    // deliberately NO yield here — this is the defect being guarded against
  }
  return seen;
}

describe('event-loop yield (P-014 half 3)', () => {
  it('CONTROL: a non-yielding read over a warm log starves the timer phase', async () => {
    const log = warmLog(corpus(OP_COUNT));
    const verdict = await observeYield(() => foldWithoutYielding(log, OP_COUNT));
    expect(verdict).toBe('after');
  });

  it('CONTROL: the probe does land DURING an operation that yields', async () => {
    // Calibration for the calibration: proves `observeYield` reports 'during' when a yield
    // genuinely happens, so its 'after' above is a real observation and not a stuck value.
    //
    // Note it takes MORE THAN ONE yield, and that is a property of the loop rather than of
    // this test: `setImmediate` runs in the CHECK phase, which the current iteration reaches
    // WITHOUT having passed back through the timers phase — so a single yield can resolve
    // before the armed timer ever gets a turn. (Measured: a one-shot version of this case
    // reported 'after'.) The real subject yields once per read window, so this mirrors it.
    const verdict = await observeYield(async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    });
    expect(verdict).toBe('during');
  });

  it('produceLogSnapshot yields to the timer phase while reading a warm log', async () => {
    const log = warmLog(corpus(OP_COUNT));
    const verdict = await observeYield(() =>
      produceLogSnapshot(log, { now: OP_COUNT + 10, schemaVersion: 1 }),
    );
    expect(verdict).toBe('during');
  });

  it('yielding does not change what the snapshot produces', async () => {
    // The yield must be invisible to the OUTPUT — same coverage, same rows. A "fix" that
    // dropped or reordered ops would otherwise pass the starvation guard above.
    const ops = corpus(OP_COUNT);
    const res = await produceLogSnapshot(warmLog(ops), {
      now: OP_COUNT + 10,
      schemaVersion: 1,
    });
    expect(res.appended).toBe(true);
    expect(res.coversUpTo).toBe(OP_COUNT);
    expect(res.rowCount).toBe(OP_COUNT); // OP_COUNT distinct keys, all live
  });

  it('keeps a repeating timer firing throughout the read, not just once', async () => {
    // The single-shot probe proves the loop reaches the timer phase at least once. The
    // routines ticker is a `setInterval`, so what actually matters is that it keeps getting
    // turns — a yield that happened only once would still starve it in practice.
    //
    // This case needs a corpus big enough that the read spans real time: a repeating timer
    // can only fire once it is DUE, so at OP_COUNT (3 windows, sub-millisecond) it would
    // report 0 ticks against a perfectly correct implementation. That is a statement about
    // the clock, not about yielding — hence the larger corpus here and the single-shot,
    // wall-clock-independent probe above as the primary guard.
    const many = SNAPSHOT_READ_CONCURRENCY * 200;
    const log = warmLog(corpus(many));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await produceLogSnapshot(log, { now: many + 10, schemaVersion: 1 });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
