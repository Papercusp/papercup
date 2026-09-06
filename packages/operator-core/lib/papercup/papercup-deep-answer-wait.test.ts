/**
 * awaitDeepAnswer — the same-turn return leg of voice:delegate_deep
 * (papercup-chat-one-component-one-contract-2026-09-06 P-005, D-007 §3).
 * Pure polling core; reader + clock injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { awaitDeepAnswer, renderDeepAnswerPending } from './papercup-deep-answer-wait';

const isTerminal = (s: string) => s === 'resolved' || s === 'closed';

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('awaitDeepAnswer', () => {
  it('returns the completion summary as the answer once the item settles', async () => {
    const clock = fakeClock();
    const states = ['open', 'open', 'resolved'];
    const read = vi.fn(async () => ({
      state: states.shift() ?? 'resolved',
      terminalCompletionRef: states.length === 0 ? '  The safer option is B.  ' : null,
      title: 'Deep dive: compare A vs B',
    }));
    const r = await awaitDeepAnswer({ workItemId: 'WI-1', harness: null, waitMs: 60_000, pollMs: 1_000, read, isTerminal, ...clock });
    expect(r).toEqual({ settled: true, state: 'resolved', answer: 'The safer option is B.', title: 'Deep dive: compare A vs B' });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('gives up at the budget and reports pending with the last seen state', async () => {
    const clock = fakeClock();
    const read = vi.fn(async () => ({ state: 'open', terminalCompletionRef: null, title: 't' }));
    const r = await awaitDeepAnswer({ workItemId: 'WI-2', harness: null, waitMs: 5_000, pollMs: 2_000, read, isTerminal, ...clock });
    expect(r).toEqual({ settled: false, state: 'open', waitedMs: 4_000 });
    expect(renderDeepAnswerPending('WI-2', 4_000)).toContain('WI-2');
    expect(renderDeepAnswerPending('WI-2', 4_000)).toContain('4s');
  });

  it('a settled item with no recorded summary settles with answer:null; a read failure is tolerated', async () => {
    const clock = fakeClock();
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('pg hiccup');
      return { state: 'closed', terminalCompletionRef: '', title: 't' };
    });
    const r = await awaitDeepAnswer({ workItemId: 'WI-3', harness: null, waitMs: 60_000, pollMs: 1_000, read, isTerminal, ...clock });
    expect(r).toEqual({ settled: true, state: 'closed', answer: null, title: 't' });
  });

  it('stops waiting as soon as the turn is aborted', async () => {
    const clock = fakeClock();
    const ac = new AbortController();
    const read = vi.fn(async () => {
      ac.abort();
      return { state: 'open', terminalCompletionRef: null, title: 't' };
    });
    const r = await awaitDeepAnswer({ workItemId: 'WI-4', harness: null, waitMs: 600_000, pollMs: 1_000, read, isTerminal, signal: ac.signal, ...clock });
    expect(r.settled).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
