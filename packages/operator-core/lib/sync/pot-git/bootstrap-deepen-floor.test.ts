/**
 * EI-18808621019872598 — the `--deepen` ladder must be able to descend to a rung
 * a SHORT-LIVED channel can actually carry.
 *
 * The blocker: measured peer channel lifetime on the p2p-git transport is
 * 1.6-12 s with a ~1 s mean, and a rung that cannot finish inside one channel
 * never lands, at any number of retries. The rung-size floor was 16 commits, and
 * the backoff is `floor(n / 2)` re-clamped by the floor — so the descent bottomed
 * out AT 16. If 16 commits did not fit the channel, every rung failed forever and
 * the join made *zero* progress. Not slow convergence: none.
 *
 * Why a unit test when the ladder already has an integration suite: the three
 * tests that pin this constant (`bootstrap.integration.test.ts`) are
 * Docker/testcontainers and are not selected by an ordinary `test:affected` run,
 * so nothing cheap failed if the floor was raised back. This file is that guard,
 * and it drives the REAL `clampDeepenStep` rather than a local copy of the
 * arithmetic — a guard that re-implements the logic it polices cannot see the
 * logic change underneath it.
 */
import { describe, expect, it } from 'vitest';

import {
  INITIAL_DEEPEN_COMMITS,
  MAX_DEEPEN_COMMITS,
  MIN_DEEPEN_COMMITS,
  clampDeepenStep,
} from './bootstrap';

/** The production backoff, exactly as `bootstrapFromPeer` applies it on a failed
 *  rung: halve, then re-clamp. */
const halve = (n: number): number => clampDeepenStep(Math.floor(n / 2));

/**
 * CONTROL — the pre-fix floor of 16, kept permanently so these assertions stay
 * falsifiable. Every "descends to 1" expectation below is paired with a check
 * that this control does NOT, which is what proves the assertion discriminates
 * rather than passing for some incidental reason.
 */
const PRE_FIX_FLOOR = 16;
const halveWithPreFixFloor = (n: number): number =>
  Math.min(Math.max(Math.floor(n / 2), PRE_FIX_FLOOR), MAX_DEEPEN_COMMITS);

/** Walk the backoff to its fixed point — the size the ladder is stuck at once a
 *  link keeps failing. Bounded so a non-converging step function fails loudly
 *  instead of hanging the suite. */
function backoffFixedPoint(from: number, step: (n: number) => number): number {
  let n = from;
  for (let i = 0; i < 1000; i++) {
    const next = step(n);
    if (next === n) return n;
    n = next;
  }
  throw new Error(`backoff never reached a fixed point from ${from}`);
}

describe('deepen ladder floor (EI-18808621019872598)', () => {
  it('backs off all the way to a SINGLE commit, so a short-channel link always has a landable rung', () => {
    for (const from of [INITIAL_DEEPEN_COMMITS, MAX_DEEPEN_COMMITS, 512, 17]) {
      expect(
        backoffFixedPoint(from, halve),
        `descent from ${from} must bottom out at the true atom (1 commit)`,
      ).toBe(1);
    }
  });

  it('CONTROL: the pre-fix floor stalls the descent above 1 — so the assertion above is discriminating', () => {
    // If this ever equals 1, the control has stopped being a control and the
    // test above proves nothing.
    expect(backoffFixedPoint(INITIAL_DEEPEN_COMMITS, halveWithPreFixFloor)).toBe(PRE_FIX_FLOOR);
    expect(backoffFixedPoint(INITIAL_DEEPEN_COMMITS, halveWithPreFixFloor)).not.toBe(
      backoffFixedPoint(INITIAL_DEEPEN_COMMITS, halve),
    );
  });

  it('never yields a zero or negative rung — `--deepen=0` is a no-op rung that would spin forever', () => {
    for (const n of [0, -1, -8192, Number.NEGATIVE_INFINITY]) {
      expect(clampDeepenStep(n)).toBeGreaterThanOrEqual(1);
    }
    // The floor IS the atom: one commit is the smallest unit of durable progress.
    expect(MIN_DEEPEN_COMMITS).toBe(1);
  });

  it('CALIBRATION: the clamp is not the identity — the ceiling is still enforced', () => {
    // Without this, a clamp accidentally rewritten to `n => n` would satisfy
    // every "descends to 1" assertion above (floor(n/2) reaches 0, not 1) only
    // by luck, and would silently uncap the top of the ladder.
    expect(clampDeepenStep(MAX_DEEPEN_COMMITS * 4)).toBe(MAX_DEEPEN_COMMITS);
    expect(clampDeepenStep(INITIAL_DEEPEN_COMMITS)).toBe(INITIAL_DEEPEN_COMMITS);
  });

  it('a landed rung can still climb geometrically out of the floor within one tick', () => {
    // This is what makes a floor of 1 an escape hatch rather than a crawl: the
    // control law DOUBLES a rung that lands well inside its target, and a tick
    // runs up to DEFAULT_MAX_STEPS (12) rungs. Starting from the floor, that
    // reaches the ceiling region in a single tick.
    let n = MIN_DEEPEN_COMMITS;
    for (let i = 0; i < 12; i++) n = clampDeepenStep(n * 2);
    expect(n).toBeGreaterThanOrEqual(INITIAL_DEEPEN_COMMITS);
  });
});
