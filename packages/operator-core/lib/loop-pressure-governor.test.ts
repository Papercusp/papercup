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

describe('pool-burn lever (WI-41147 leg b)', () => {
  let handle: LoopPressureGovernorHandle | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  /** A governor with an injected burn reader; pressure pinned to 'ok' so levers don't mix. */
  const start = (readPoolBurn: () => Promise<{ action: 'none' | 'throttle' | 'shed'; reason: string }>, spies?: { onPenalty?: () => void; onClean?: () => void }) =>
    startLoopPressureGovernor({
      intervalMs: 1e9,
      burnIntervalMs: 1e9,
      readPressure: () => 'ok',
      readPoolBurn,
      onPenalty: spies?.onPenalty ?? (() => {}),
      onClean: spies?.onClean ?? (() => {}),
      log: () => {},
    });

  it('penalizes ONCE on none→throttle, debounced while the pool STAYS throttled', async () => {
    let action: 'none' | 'throttle' | 'shed' = 'none';
    const onPenalty = vi.fn();
    const onClean = vi.fn();
    handle = start(async () => ({ action, reason: 'test' }), { onPenalty, onClean });
    await handle.tickBurn(); // none → none: nothing
    expect(onPenalty).not.toHaveBeenCalled();
    action = 'throttle';
    await handle.tickBurn(); // none → throttle ⇒ one penalty
    await handle.tickBurn(); // still throttle ⇒ no repeat
    await handle.tickBurn();
    expect(onPenalty).toHaveBeenCalledTimes(1);
    expect(onClean).not.toHaveBeenCalled();
  });

  it('escalation throttle→shed is a new, worse episode — second penalty', async () => {
    let action: 'none' | 'throttle' | 'shed' = 'throttle';
    const onPenalty = vi.fn();
    handle = start(async () => ({ action, reason: 'test' }), { onPenalty });
    await handle.tickBurn(); // none → throttle ⇒ penalty 1
    action = 'shed';
    await handle.tickBurn(); // throttle → shed ⇒ penalty 2
    await handle.tickBurn(); // still shed ⇒ no repeat
    expect(onPenalty).toHaveBeenCalledTimes(2);
  });

  it('de-escalation shed→throttle fires NOTHING; recovery to none fires one clean', async () => {
    let action: 'none' | 'throttle' | 'shed' = 'shed';
    const onPenalty = vi.fn();
    const onClean = vi.fn();
    handle = start(async () => ({ action, reason: 'test' }), { onPenalty, onClean });
    await handle.tickBurn(); // none → shed ⇒ penalty 1
    action = 'throttle';
    await handle.tickBurn(); // shed → throttle: still degraded ⇒ nothing
    expect(onPenalty).toHaveBeenCalledTimes(1);
    expect(onClean).not.toHaveBeenCalled();
    action = 'none';
    await handle.tickBurn(); // throttle → none ⇒ one clean
    expect(onClean).toHaveBeenCalledTimes(1);
    expect(onPenalty).toHaveBeenCalledTimes(1);
  });

  it('a FAILED pool read keeps the last verdict — never a fake recovery clean', async () => {
    let fail = false;
    let action: 'none' | 'throttle' | 'shed' = 'throttle';
    const onClean = vi.fn();
    handle = start(
      async () => {
        if (fail) throw new Error('pg down');
        return { action, reason: 'test' };
      },
      { onClean },
    );
    await handle.tickBurn(); // none → throttle (episode open)
    fail = true;
    await handle.tickBurn(); // read fails ⇒ no transition, no clean
    await handle.tickBurn();
    expect(onClean).not.toHaveBeenCalled();
    fail = false;
    action = 'none';
    await handle.tickBurn(); // real recovery still lands after the outage
    expect(onClean).toHaveBeenCalledTimes(1);
  });

  it('in-flight guard — a pending pool read is never doubled', async () => {
    let resolveRead: ((v: { action: 'none' | 'throttle' | 'shed'; reason: string }) => void) | undefined;
    const reader = vi.fn(
      () => new Promise<{ action: 'none' | 'throttle' | 'shed'; reason: string }>((res) => { resolveRead = res; }),
    );
    handle = start(reader);
    const first = handle.tickBurn();
    const second = handle.tickBurn(); // guarded — returns without a second read
    expect(reader).toHaveBeenCalledTimes(1);
    resolveRead!({ action: 'none', reason: 'test' });
    await Promise.all([first, second]);
  });

  it('burn and pressure levers debounce INDEPENDENTLY on the shared AIMD seam', async () => {
    let p: LoopPressure = 'ok';
    let action: 'none' | 'throttle' | 'shed' = 'none';
    const onPenalty = vi.fn();
    handle = startLoopPressureGovernor({
      intervalMs: 1e9,
      burnIntervalMs: 1e9,
      readPressure: () => p,
      readPoolBurn: async () => ({ action, reason: 'test' }),
      onPenalty,
      onClean: () => {},
      log: () => {},
    });
    p = 'critical';
    handle.tick(); // pressure episode ⇒ penalty 1
    action = 'throttle';
    await handle.tickBurn(); // burn episode ⇒ penalty 2 (its own debounce, not blocked by pressure's)
    handle.tick(); // still critical ⇒ no repeat
    await handle.tickBurn(); // still throttle ⇒ no repeat
    expect(onPenalty).toHaveBeenCalledTimes(2);
  });
});
