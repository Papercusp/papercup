/**
 * loop-pressure-governor.test.ts — P5-2.
 *
 * The governor turns the P5-1 loopPressure() band into AIMD concurrency feedback.
 * The risk it must NOT have is cratering concurrency: a loop that STAYS critical
 * must be penalized once per episode, not once per tick. These pin the transition
 * (debounce) semantics with an injected pressure source + spies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLoopPressureGovernor, type LoopPressureGovernorHandle } from './loop-pressure-governor';
import type { LoopPressure } from './event-loop-lag-monitor';

describe('loop-pressure governor (P5-2)', () => {
  let handle: LoopPressureGovernorHandle | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  it('penalizes ONCE on transition into critical, not every tick (debounce)', () => {
    let p: LoopPressure = 'ok';
    const onPenalty = vi.fn();
    const onClean = vi.fn();
    handle = startLoopPressureGovernor({
      intervalMs: 1e9, readPressure: () => p, onPenalty, onClean, log: () => {},
    });
    handle.tick(); // ok → nothing
    expect(onPenalty).not.toHaveBeenCalled();
    p = 'critical';
    handle.tick(); // ok → critical ⇒ one penalty
    handle.tick(); // still critical ⇒ no repeat
    handle.tick();
    expect(onPenalty).toHaveBeenCalledTimes(1);
    expect(onClean).not.toHaveBeenCalled();
  });

  it('records a clean step on transition back to ok', () => {
    let p: LoopPressure = 'critical';
    const onPenalty = vi.fn();
    const onClean = vi.fn();
    handle = startLoopPressureGovernor({
      intervalMs: 1e9, readPressure: () => p, onPenalty, onClean, log: () => {},
    });
    handle.tick(); // initial(ok) → critical ⇒ penalty
    expect(onPenalty).toHaveBeenCalledTimes(1);
    p = 'ok';
    handle.tick(); // critical → ok ⇒ clean
    expect(onClean).toHaveBeenCalledTimes(1);
  });

  it('does NOT penalize on elevated — only critical sheds', () => {
    const onPenalty = vi.fn();
    handle = startLoopPressureGovernor({
      intervalMs: 1e9, readPressure: () => 'elevated' as LoopPressure, onPenalty, onClean: () => {}, log: () => {},
    });
    handle.tick();
    handle.tick();
    expect(onPenalty).not.toHaveBeenCalled();
  });

  it('re-penalizes on a fresh critical episode after recovering', () => {
    let p: LoopPressure = 'ok';
    const onPenalty = vi.fn();
    handle = startLoopPressureGovernor({
      intervalMs: 1e9, readPressure: () => p, onPenalty, onClean: () => {}, log: () => {},
    });
    p = 'critical'; handle.tick(); // penalty 1
    p = 'ok'; handle.tick();
    p = 'critical'; handle.tick(); // penalty 2 (new episode)
    expect(onPenalty).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — a second start returns the same handle', () => {
    handle = startLoopPressureGovernor({ intervalMs: 1e9, readPressure: () => 'ok', log: () => {} });
    const again = startLoopPressureGovernor({ intervalMs: 1e9, readPressure: () => 'ok', log: () => {} });
    expect(again).toBe(handle);
  });
});
