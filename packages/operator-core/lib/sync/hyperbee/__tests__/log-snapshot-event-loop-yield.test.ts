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
 * is therefore a direct read of "did this operation yield": it asserts no threshold and
 * sleeps for nothing.
 *
 * ⚠ It is NOT wall-clock-INDEPENDENT, and reading it that way has red-pinned the fleet's
 * release gate twice. Node clamps `setTimeout(…, 0)` to 1ms, so a read that yields perfectly
 * AND finishes inside that clamp still reports `'after'` — the probe never got a turn to
 * land. Any case whose verdict is `'during'` must therefore span MORE wall clock than the
 * clamp: by yielding against a budget (CONTROL 2) or by reading a corpus big enough to
 * outlive it (`SPANNING_READ_WINDOWS`). A case tuned to a fixed count instead is a race that
 * is eventually lost on a busy box — twice now, on trees where nothing had changed.
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
 * Windows a case must span when its verdict depends on the armed probe LANDING (`'during'`).
 *
 * The probe is a `setTimeout(…, 0)` clamped to 1ms, so `'during'` requires the read to still
 * be running 1ms after it starts. Three windows over a warm log sits close enough to that 1ms
 * that the verdict is decided by whatever else is true of the process: a read finishing inside
 * the clamp reports `'after'` no matter how faithfully it yielded.
 *
 * MEASURED on the 2026-08-14 failure: rssMb ~1018, against ~120 for the same file run alone.
 * loopLagP95Ms 20.4, against 20.5-31.3 on contemporaneous passes.
 *
 * HYPOTHESIS — NOT VERIFIED, do not cite it as the cause: that the gate's long-lived worker
 * (warm JIT, thousands of tests already executed) runs the same read fast enough to finish
 * inside the clamp. It fits every number above, but read duration was never measured cold
 * against warm. What the numbers DO rule out is event-loop contention — loopLag is flat, and
 * that was the first wrong guess on both occasions this file bit.
 *
 * The sizing below deliberately does not rest on which mechanism is right. Every candidate
 * reduces to "the read stopped before the probe landed", and a longer read widens that margin
 * under all of them.
 *
 * ⚠ Do NOT re-derive this as an event-loop CONTENTION story: loopLagP95Ms was 20.4 on that
 * failure versus 20.5-31.3 on contemporaneous passes, i.e. not elevated. The margin that
 * matters is the read's own duration against the clamp, which is why the fix is to lengthen
 * the read rather than to wait longer for the timer.
 *
 * ⚠ This is why the fix is a bigger corpus rather than a loosened assertion: it CANNOT weaken
 * the guard. A read that does not yield starves the timer at every corpus size — precisely
 * what CONTROL 1 asserts — so `'during'` still means the yield genuinely happened.
 */
const SPANNING_READ_WINDOWS = 200;

/** Hard bound on that loop, so a broken instrument fails fast instead of spinning. */
const CONTROL_YIELD_SPIN_CAP = 10_000;

/**
 * Arms a timer-phase probe, runs `op`, and reports whether the timer got a turn WHILE `op`
 * was still running. `'during'` = the operation yielded; `'after'` = it starved the loop.
 *
 * `op` receives `probeLanded()` — whether the armed timer has ALREADY had its turn. That
 * predicate is what lets a yield-until-observed case (the second CONTROL) stop on the event
 * it is actually waiting for instead of on a guessed duration. A case that does not care
 * simply ignores the argument; a zero-arg `op` stays assignable.
 */
async function observeYield(
  op: (probeLanded: () => boolean) => Promise<unknown>,
): Promise<'during' | 'after'> {
  let finished = false;
  let fired = false;
  let landed: 'during' | 'after' | null = null;
  const armed = new Promise<void>((resolve) => {
    setTimeout(() => {
      fired = true;
      landed = finished ? 'after' : 'during';
      resolve();
    }, 0);
  });
  await op(() => fired);
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
    // It takes MORE THAN ONE yield, and that is a property of the loop rather than of this
    // test: `setImmediate` runs in the CHECK phase, which the current iteration reaches
    // WITHOUT having passed back through the timers phase — so a single yield can resolve
    // before the armed timer ever gets a turn.
    //
    // ⚠ Yield until the armed timer has OBSERVABLY had its turn — never a fixed count, and
    // never a wall-clock budget. Two earlier shapes of this loop both raced the host:
    //   - a hardcoded 3 yields (tuned empirically) reported 'after' on 2 of 3 consecutive
    //     runs at load average 25 on 2026-08-09;
    //   - a 5ms budget replaced it and lost the SAME race on 2026-08-14, because a saturated
    //     timers phase can be delayed past any fixed budget. Waiting "long enough" for a
    //     phase whose delay is unbounded under load is not a fix, it is a longer race.
    // Both failures red-pinned the fleet's release gate on a file nothing had changed.
    //
    // `probeLanded()` is the event this case was always really waiting for, so it now waits
    // on THAT rather than on a proxy for it. The loop exits the moment the timer has run,
    // whatever the host is doing — no clock, no tuned constant, nothing load-dependent.
    //
    // This does NOT weaken the control. Every iteration is still a real yield, and the
    // assertion is unchanged: if `observeYield` ever goes stuck-at-'after', `probeLanded()`
    // still flips (the callback ran) and the verdict it recorded is 'after', so the case
    // fails exactly as it should. The spin cap keeps a BROKEN instrument — one whose timer
    // never runs at all — failing fast instead of spinning forever.
    const verdict = await observeYield(async (probeLanded) => {
      for (let spins = 0; spins < CONTROL_YIELD_SPIN_CAP && !probeLanded(); spins += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    });
    expect(verdict).toBe('during');
  });

  it('produceLogSnapshot yields to the timer phase while reading a warm log', async () => {
    // ⚠ Spans SPANNING_READ_WINDOWS rather than OP_COUNT's three. At three windows the read is
    // near enough to the probe's 1ms clamp that the verdict turns on how fast the process
    // happens to be running this file, not on whether the read yielded. That is the same
    // defect CONTROL 2 was hardened against on 2026-08-09 — the correction was simply never
    // carried across to the subject — and it red-pinned the gate again on 2026-08-14 as the
    // sole failure in a 4,533-row run whose tree differed by three .md files.
    const opCount = SNAPSHOT_READ_CONCURRENCY * SPANNING_READ_WINDOWS;
    const log = warmLog(corpus(opCount));
    const verdict = await observeYield(() =>
      produceLogSnapshot(log, { now: opCount + 10, schemaVersion: 1 }),
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
    // the clock, not about yielding — hence the larger corpus here.
    //
    // The single-shot probe above needs it for exactly the same reason, which is what this
    // comment used to miss when it called that probe "wall-clock-independent": a 1ms-clamped
    // `setTimeout` is no more able to fire inside a sub-millisecond read than a 1ms
    // `setInterval` is. The insight was applied to this case and not to that one, and that
    // gap is what kept red-pinning the gate. Both now share the one constant.
    const many = SNAPSHOT_READ_CONCURRENCY * SPANNING_READ_WINDOWS;
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
