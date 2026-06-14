import { describe, test, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  publish,
  subscribe,
  closeChannel,
  busStats,
  _resetRunChunkBus,
} from './run-chunk-bus';

beforeEach(() => {
  _resetRunChunkBus();
});

describe('run-chunk-bus', () => {
  test('publish before subscribe — recent ring delivers catch-up', () => {
    publish('r1', 0, 'first');
    publish('r1', 1, 'second');
    const seen: string[] = [];
    const sub = subscribe('r1', (e) => seen.push(e.data));
    assert.deepEqual(sub.recent.map((e) => e.data), ['first', 'second']);
    assert.equal(seen.length, 0, 'recent is returned, not delivered via handler');
    sub.unsubscribe();
  });

  test('subscribe then publish — handler receives every chunk', () => {
    const seen: string[] = [];
    const sub = subscribe('r2', (e) => seen.push(e.data));
    publish('r2', 0, 'a');
    publish('r2', 1, 'b');
    publish('r2', 2, 'c');
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(sub.recent.length, 0, 'subscribed before publish, recent is empty');
    sub.unsubscribe();
  });

  test('multiple subscribers — fan-out delivers to all', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const subA = subscribe('r3', (e) => seenA.push(e.data));
    const subB = subscribe('r3', (e) => seenB.push(e.data));
    publish('r3', 0, 'shared');
    assert.deepEqual(seenA, ['shared']);
    assert.deepEqual(seenB, ['shared']);
    subA.unsubscribe();
    subB.unsubscribe();
  });

  test('unsubscribe — handler stops receiving', () => {
    const seen: string[] = [];
    const sub = subscribe('r4', (e) => seen.push(e.data));
    publish('r4', 0, 'before-unsubscribe');
    sub.unsubscribe();
    publish('r4', 1, 'after-unsubscribe');
    assert.deepEqual(seen, ['before-unsubscribe']);
  });

  test('closeChannel — whenDone resolves + late publish silently dropped', async () => {
    const seen: string[] = [];
    const sub = subscribe('r5', (e) => seen.push(e.data));
    publish('r5', 0, 'live');
    closeChannel('r5');
    await sub.whenDone;
    publish('r5', 1, 'late');
    assert.deepEqual(seen, ['live']);
    assert.equal(sub.isClosed(), true);
    sub.unsubscribe();
  });

  test('whenDone resolves immediately if channel already closed when subscribing', async () => {
    publish('r6', 0, 'a');
    closeChannel('r6');
    const sub = subscribe('r6', () => {});
    await sub.whenDone; // should resolve immediately
    sub.unsubscribe();
  });

  test('recent ring — caps at 64 entries, oldest dropped', () => {
    for (let i = 0; i < 100; i++) publish('r7', i, `chunk-${i}`);
    const sub = subscribe('r7', () => {});
    assert.equal(sub.recent.length, 64);
    assert.equal(sub.recent[0].seq, 36, 'kept the most recent 64 (seqs 36..99)');
    assert.equal(sub.recent[63].seq, 99);
    sub.unsubscribe();
  });

  test('handler errors do not crash the producer', () => {
    const sub = subscribe('r8', () => {
      throw new Error('handler boom');
    });
    // Should not throw
    publish('r8', 0, 'data');
    sub.unsubscribe();
  });

  test('busStats — counts active and closed channels + subscribers', () => {
    const sub1 = subscribe('a', () => {});
    const sub2 = subscribe('a', () => {});
    const sub3 = subscribe('b', () => {});
    publish('a', 0, 'x');
    closeChannel('b');
    const stats = busStats();
    assert.equal(stats.totalSubscribers, 3);
    assert.equal(stats.activeChannels, 1);
    assert.equal(stats.closedChannels, 1);
    sub1.unsubscribe();
    sub2.unsubscribe();
    sub3.unsubscribe();
  });

  test('closeChannel prunes the bus-level closed marker after GC (no per-run leak)', () => {
    // The closed set marked one entry per run and never pruned it — a slow but
    // strictly-unbounded leak under fleet load (EI-127). It must drop once the
    // underlying channel has been GC'd.
    vi.useFakeTimers();
    try {
      closeChannel('rprune');
      const set = (globalThis as { __runChunkBusClosed__?: Set<string> }).__runChunkBusClosed__!;
      assert.equal(set.has('run-chunk:rprune'), true, 'marked closed immediately');
      // Past CLOSED_CHANNEL_GC_MS (5min) + the 1s prune delay.
      vi.advanceTimersByTime(5 * 60_000 + 2_000);
      assert.equal(set.has('run-chunk:rprune'), false, 'closed marker pruned after GC window');
    } finally {
      vi.useRealTimers();
    }
  });
});
