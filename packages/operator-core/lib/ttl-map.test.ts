/**
 * TtlMap — the bounded TTL cache shape replacing the grow-forever
 * `Map<string, {value, expiresAt}>` pattern (EI-79/EI-127, audit P-004).
 */
import { describe, expect, it } from 'vitest';
import { TtlMap } from './ttl-map';

describe('TtlMap', () => {
  it('serves a live entry and misses after the TTL', () => {
    const m = new TtlMap<string>({ ttlMs: 100 });
    m.set('a', 'v', 1000);
    expect(m.get('a', 1099)).toBe('v');
    expect(m.get('a', 1100)).toBeUndefined();
  });

  it('deletes an expired entry on read (no dead-key retention)', () => {
    const m = new TtlMap<string>({ ttlMs: 100 });
    m.set('a', 'v', 1000);
    expect(m.size).toBe(1);
    m.get('a', 2000);
    expect(m.size).toBe(0);
  });

  it('sweeps every expired key on set', () => {
    const m = new TtlMap<number>({ ttlMs: 100 });
    m.set('a', 1, 1000);
    m.set('b', 2, 1000);
    m.set('c', 3, 1500); // a + b expired by now → swept
    expect(m.size).toBe(1);
    expect(m.get('c', 1500)).toBe(3);
  });

  it('distinguishes a cached null from a miss via getEntry', () => {
    const m = new TtlMap<string | null>({ ttlMs: 100 });
    m.set('neg', null, 1000);
    expect(m.getEntry('neg', 1050)).toEqual({ value: null, expiresAt: 1100 });
    expect(m.getEntry('absent', 1050)).toBeUndefined();
  });

  it('evicts the oldest live insertion at maxEntries', () => {
    const m = new TtlMap<number>({ ttlMs: 10_000, maxEntries: 2 });
    m.set('a', 1, 1000);
    m.set('b', 2, 1001);
    m.set('c', 3, 1002);
    expect(m.size).toBe(2);
    expect(m.get('a', 1003)).toBeUndefined(); // evicted
    expect(m.get('b', 1003)).toBe(2);
    expect(m.get('c', 1003)).toBe(3);
  });

  it('refreshing an existing key does not evict and resets its TTL', () => {
    const m = new TtlMap<number>({ ttlMs: 100, maxEntries: 2 });
    m.set('a', 1, 1000);
    m.set('b', 2, 1000);
    m.set('a', 10, 1050);
    expect(m.size).toBe(2);
    expect(m.get('a', 1149)).toBe(10); // TTL re-anchored at 1050
    expect(m.get('b', 1099)).toBe(2);
  });
});
