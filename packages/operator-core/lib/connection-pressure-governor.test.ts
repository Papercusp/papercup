/**
 * connection-pressure-governor.test.ts — C5-1 (backend-connection-scaling-2026-06-17).
 *
 * The governor turns PG server-wide saturation into AIMD concurrency feedback, the
 * sibling of the loop-pressure governor (P5-2). The two risks it must NOT have:
 *   - cratering concurrency: a saturation that STAYS critical must penalize once per
 *     episode, not every observation;
 *   - flapping: a saturation hovering in the hysteresis gap must not toggle the AIMD
 *     state. These pin the band thresholds + the transition-debounce semantics with
 *     injected spies (no Postgres).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  connectionPressureBand,
  createConnectionPressureGovernor,
  CONN_SHED_PCT,
  CONN_RECOVER_PCT,
} from './connection-pressure-governor';

describe('connectionPressureBand — hysteresis thresholds', () => {
  it('is critical at/above the shed threshold', () => {
    expect(connectionPressureBand(CONN_SHED_PCT)).toBe('critical');
    expect(connectionPressureBand(99)).toBe('critical');
    expect(connectionPressureBand(100)).toBe('critical');
  });
  it('is ok at/below the recover threshold', () => {
    expect(connectionPressureBand(CONN_RECOVER_PCT)).toBe('ok');
    expect(connectionPressureBand(0)).toBe('ok');
    expect(connectionPressureBand(30)).toBe('ok');
  });
  it('is elevated in the hysteresis gap (no transition)', () => {
    expect(connectionPressureBand(CONN_RECOVER_PCT + 1)).toBe('elevated');
    expect(connectionPressureBand(CONN_SHED_PCT - 1)).toBe('elevated');
    expect(connectionPressureBand(85)).toBe('elevated');
  });
});

describe('connection-pressure governor (C5-1)', () => {
  it('penalizes ONCE on transition into critical, not every observation (debounce)', () => {
    const onPenalty = vi.fn();
    const onClean = vi.fn();
    const g = createConnectionPressureGovernor({ onPenalty, onClean, log: () => {} });
    g.observe(30); // ok → nothing
    expect(onPenalty).not.toHaveBeenCalled();
    g.observe(95); // ok → critical ⇒ one penalty
    g.observe(96); // still critical ⇒ no repeat
    g.observe(99);
    expect(onPenalty).toHaveBeenCalledTimes(1);
    expect(onClean).not.toHaveBeenCalled();
  });

  it('records a clean step on transition back to ok', () => {
    const onPenalty = vi.fn();
    const onClean = vi.fn();
    const g = createConnectionPressureGovernor({ onPenalty, onClean, log: () => {} });
    g.observe(95); // initial(ok) → critical ⇒ penalty
    expect(onPenalty).toHaveBeenCalledTimes(1);
    g.observe(70); // critical → ok ⇒ clean
    expect(onClean).toHaveBeenCalledTimes(1);
  });

  it('does NOT flap in the hysteresis gap — elevated holds the last decisive band', () => {
    const onPenalty = vi.fn();
    const onClean = vi.fn();
    const g = createConnectionPressureGovernor({ onPenalty, onClean, log: () => {} });
    g.observe(95); // → critical (penalty 1)
    g.observe(85); // elevated — still in gap, hold critical, NO clean
    g.observe(80); // elevated — hold, NO clean
    g.observe(88); // elevated — hold
    expect(onPenalty).toHaveBeenCalledTimes(1);
    expect(onClean).not.toHaveBeenCalled();
    g.observe(70); // finally below recover → ok ⇒ clean
    expect(onClean).toHaveBeenCalledTimes(1);
  });

  it('does NOT penalize on a first observation that is merely elevated', () => {
    const onPenalty = vi.fn();
    const g = createConnectionPressureGovernor({ onPenalty, onClean: () => {}, log: () => {} });
    g.observe(85); // elevated from the initial ok — no shed
    g.observe(89);
    expect(onPenalty).not.toHaveBeenCalled();
  });

  it('re-penalizes on a fresh critical episode after recovering', () => {
    const onPenalty = vi.fn();
    const g = createConnectionPressureGovernor({ onPenalty, onClean: () => {}, log: () => {} });
    g.observe(95); // penalty 1
    g.observe(60); // recover
    g.observe(95); // penalty 2 (new episode)
    expect(onPenalty).toHaveBeenCalledTimes(2);
  });
});
