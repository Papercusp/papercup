/**
 * Recurrence guard for EI-20581532536662596.
 *
 * THE DEFECT: the replication scenarios awaited each reader's 'caught-up' event
 * SERIALLY, giving every reader a FRESH budget at the moment the loop reached it.
 * Since `waitFor` resolves immediately for an already-fired event, reader 0 was
 * judged against `budget` measured from loop start while reader N was judged
 * against `budget` PLUS all the time already spent waiting on readers 0..N-1.
 * The deadline was therefore a property of a reader's POSITION IN THE ITERATION
 * ORDER rather than of the run — so a red convergence verdict could not separate
 * "the substrate failed to replicate" from "the box was loaded".
 *
 * THE PROPERTY GUARDED HERE: every reader is judged against ONE SHARED deadline,
 * so a reader that misses it is reported as not-converged REGARDLESS of where it
 * sits in the array.
 *
 * WHY THIS TEST IS FALSIFIABLE (it must fail against the old serial code): with
 * EARLY=200ms, LATE=400ms and BUDGET=300ms, reader 1 fires at 400ms. Against the
 * SHARED deadline that is a miss (400 > 300) and is correctly reported null. Under
 * the SERIAL loop reader 1 is only awaited from ~200ms, handing it until ~500ms —
 * so the identical run is scored CONVERGED. The serial implementation is strictly
 * MORE LENIENT for later readers, and in the real N-reader case that window grows
 * with every reader ahead in the list; a genuinely-lagging reader is scored
 * converged purely for being late in the array. The CONTROL test at the bottom
 * asserts the two implementations DISAGREE on exactly this input, so this file
 * cannot silently stop guarding anything.
 *
 * ⚠ The margins are deliberate: an earlier draft used 60/220/150, where BOTH
 * implementations failed the reader (the serial window was 60+150=210 < 220) and
 * the "falsifier" therefore falsified nothing. The control caught that. Keep ~100ms
 * of slack on both sides of the divergence rather than racing timer jitter.
 */
import { describe, it, expect } from 'vitest';
import { awaitAllChildEvent, type CaughtUpWaitable, type ChildEvent } from './child-driver';

/**
 * A reader whose 'caught-up' fires at a fixed offset from a SHARED run origin.
 * Faithfully reproduces the real handle's two behaviours that matter here:
 *   - an already-fired event resolves IMMEDIATELY (child-driver.ts:81-82);
 *   - otherwise it resolves null at callTime + timeoutMs.
 */
function fakeReader(origin: number, fireAtMs: number | null): CaughtUpWaitable & { id: string } {
  return {
    id: `fire@${fireAtMs ?? 'never'}`,
    waitFor(pred: string, timeoutMs: number): Promise<ChildEvent | null> {
      const calledAt = Date.now();
      if (fireAtMs === null) {
        return new Promise((r) => setTimeout(() => r(null), timeoutMs));
      }
      const fireAbs = origin + fireAtMs;
      if (fireAbs <= calledAt) return Promise.resolve({ evt: pred, t: fireAtMs });
      const deadlineAbs = calledAt + timeoutMs;
      if (fireAbs <= deadlineAbs) {
        return new Promise((r) => setTimeout(() => r({ evt: pred, t: fireAtMs }), fireAbs - calledAt));
      }
      return new Promise((r) => setTimeout(() => r(null), timeoutMs));
    },
  };
}

describe('awaitAllChildEvent — shared deadline (EI-20581532536662596)', () => {
  // Chosen so the fixed and pre-fix implementations DISAGREE with ~100ms of margin
  // on both sides, rather than racing timer jitter on a loaded box:
  //   LATE (400) > BUDGET (300)            -> the shared deadline correctly fails it
  //   LATE (400) < EARLY (200) + BUDGET    -> the serial loop wrongly passes it
  const BUDGET = 300;
  const EARLY = 200;
  const LATE = 400;
  it('CALIBRATION: readers that all catch up inside the budget all converge', async () => {
    // Without this control, a helper that returned null for everything would pass
    // the falsification test below for the wrong reason.
    const origin = Date.now();
    const readers = [40, 60, 80, 30].map((f) => fakeReader(origin, f));
    const settled = await awaitAllChildEvent(readers, 'caught-up', 200);
    expect(settled.map((s) => s.event !== null)).toEqual([true, true, true, true]);
  });

  it('FALSIFIER: a latecomer is reported not-converged even though it sits LAST', async () => {
    // The serial implementation would hand reader 1 a window starting only after
    // reader 0 resolved, scoring a genuinely-late reader as converged.
    const origin = Date.now();
    const readers = [fakeReader(origin, EARLY), fakeReader(origin, LATE)];
    const settled = await awaitAllChildEvent(readers, 'caught-up', BUDGET);
    expect(settled.map((s) => s.event !== null)).toEqual([true, false]);
  });

  it('ORDER-INDEPENDENCE: the verdict does not change when the readers are reversed', async () => {
    // The heart of the defect: identical catch-up behaviour, different array order,
    // must produce the same per-reader verdict.
    const mk = () => {
      const origin = Date.now();
      return [fireAt(origin, EARLY), fireAt(origin, LATE)] as const;
    };
    function fireAt(origin: number, ms: number) {
      return fakeReader(origin, ms);
    }

    const [a1, b1] = mk();
    const forward = await awaitAllChildEvent([a1, b1], 'caught-up', BUDGET);
    const [a2, b2] = mk();
    const reversed = await awaitAllChildEvent([b2, a2], 'caught-up', BUDGET);

    const verdict = (settled: Array<{ reader: { id: string }; event: ChildEvent | null }>) =>
      Object.fromEntries(settled.map((s) => [s.reader.id, s.event !== null]));

    expect(verdict(forward)).toEqual(verdict(reversed));
    expect(verdict(forward)).toEqual({ [`fire@${EARLY}`]: true, [`fire@${LATE}`]: false });
  });

  it('a reader that never catches up is reported not-converged, not hung', async () => {
    const origin = Date.now();
    const readers = [fakeReader(origin, 30), fakeReader(origin, null)];
    const settled = await awaitAllChildEvent(readers, 'caught-up', 120);
    expect(settled.map((s) => s.event !== null)).toEqual([true, false]);
  });

  /**
   * PERMANENT CONTROL — the pre-fix implementation, kept here on purpose.
   *
   * Tier-1 falsifiability per the repo's mutation-probe rules: prove the guard CAN
   * fail by keeping the deliberately-wrong implementation in the test file, rather
   * than mutating production code (which the git-sync sweep can commit mid-probe).
   *
   * If this control ever starts agreeing with `awaitAllChildEvent`, the fix has been
   * reverted or the fakes no longer model the defect — either way the guard above has
   * silently stopped guarding anything.
   */
  async function serialAwait_PRE_FIX<T extends CaughtUpWaitable>(
    readers: readonly T[],
    evt: string,
    budgetMs: number,
  ): Promise<Array<{ reader: T; event: ChildEvent | null }>> {
    const settled: Array<{ reader: T; event: ChildEvent | null }> = [];
    for (const reader of readers) {
      // The bug: a FRESH budget starting whenever the loop happens to get here.
      const event = await reader.waitFor(evt, budgetMs);
      settled.push({ reader, event });
    }
    return settled;
  }

  it('CONTROL: the pre-fix SERIAL implementation scores the latecomer as converged — the bug, reproduced', async () => {
    const origin = Date.now();
    const readers = [fakeReader(origin, EARLY), fakeReader(origin, LATE)];

    const serial = await serialAwait_PRE_FIX(readers, 'caught-up', BUDGET);
    // Reader 1 fires at LATE(400) — well past BUDGET(300) measured from the run's
    // start — yet the serial loop only BEGINS awaiting it at ~EARLY(200), handing it
    // until ~500ms, and in the real N-reader case ever more as the chain accumulates.
    expect(serial.map((s) => s.event !== null)).toEqual([true, true]);

    // The fixed implementation, same readers, same budget, correctly fails it.
    const origin2 = Date.now();
    const readers2 = [fakeReader(origin2, EARLY), fakeReader(origin2, LATE)];
    const shared = await awaitAllChildEvent(readers2, 'caught-up', BUDGET);
    expect(shared.map((s) => s.event !== null)).toEqual([true, false]);

    // The two implementations MUST disagree on this input. If they ever agree, this
    // guard is no longer testing anything.
    expect(serial.map((s) => s.event !== null)).not.toEqual(shared.map((s) => s.event !== null));
  });

  it('preserves input order in its results so verdicts map back to the right reader', async () => {
    const origin = Date.now();
    const readers = [fakeReader(origin, 200), fakeReader(origin, 20), fakeReader(origin, 200)];
    const settled = await awaitAllChildEvent(readers, 'caught-up', 100);
    expect(settled.map((s) => s.reader)).toEqual(readers);
    expect(settled.map((s) => s.event !== null)).toEqual([false, true, false]);
  });

  /**
   * `elapsedMs` — the headroom half of EI-20581532536662596.
   *
   * The order fix above makes the VERDICT trustworthy; these make it
   * ATTRIBUTABLE. A bare converged/not binary cannot say whether a run cleared
   * its budget by 110s or by 200ms, so when the budget and the instrument change
   * in one edit, a suddenly-green ladder reads identically whether the substrate
   * got faster or the deadline got looser. That ambiguity is exactly what these
   * timings remove — `elapsedMs` is only comparable to `budgetMs` because both
   * are measured from the SAME shared origin.
   */
  describe('elapsedMs — measured from the shared origin, so it is comparable to the budget', () => {
    it('reports each reader’s time from the ONE shared start, not from its own call', async () => {
      const origin = Date.now();
      const readers = [fakeReader(origin, 60), fakeReader(origin, 260)];
      const settled = await awaitAllChildEvent(readers, 'caught-up', 600);

      expect(settled.map((s) => s.event !== null)).toEqual([true, true]);
      // ~60ms and ~260ms from the SHARED origin. Generous slack: this asserts the
      // reference point, not timer precision on a loaded box.
      expect(settled[0].elapsedMs).toBeLessThan(200);
      expect(settled[1].elapsedMs).toBeGreaterThanOrEqual(200);
      expect(settled[1].elapsedMs).toBeLessThan(500);
    });

    it('makes headroom computable: the slowest converged reader is under the budget', async () => {
      // The claim a green run is entitled to make — "converged with N ms to
      // spare" — is only checkable because both numbers share an origin.
      const origin = Date.now();
      const BUDGET_MS = 600;
      const readers = [fakeReader(origin, 40), fakeReader(origin, 120), fakeReader(origin, 80)];
      const settled = await awaitAllChildEvent(readers, 'caught-up', BUDGET_MS);

      expect(settled.every((s) => s.event !== null)).toBe(true);
      const slowest = Math.max(...settled.map((s) => s.elapsedMs));
      expect(slowest).toBeLessThan(BUDGET_MS);
      expect(BUDGET_MS - slowest).toBeGreaterThan(0); // headroom is a real number
    });

    it('CONTROL: the pre-fix serial loop cannot produce a comparable elapsed time', async () => {
      // Not a style point — under the serial loop each reader's clock starts when
      // the loop reaches it, so "elapsed" is measured from a DIFFERENT origin per
      // reader and comparing it to one budget is meaningless. Reader 1 fires 260ms
      // after the run starts but only ~200ms after ITS OWN await began, which is
      // how a late reader books an innocent-looking time.
      const origin = Date.now();
      const readers = [fakeReader(origin, 60), fakeReader(origin, 260)];

      const perCallElapsed: number[] = [];
      for (const reader of readers) {
        const t0 = Date.now();
        await reader.waitFor('caught-up', 600);
        perCallElapsed.push(Date.now() - t0);
      }

      const shared = await awaitAllChildEvent(
        [fakeReader(Date.now(), 60), fakeReader(Date.now(), 260)],
        'caught-up',
        600,
      );

      // The serial per-call time UNDER-REPORTS the second reader: measured from
      // the shared origin it is ~260ms, from its own call only ~200ms.
      expect(perCallElapsed[1]).toBeLessThan(shared[1].elapsedMs);
    });
  });
});
