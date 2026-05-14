import { describe, it, expect } from 'vitest';
import { RunCache } from '../src/per-run-cache';

describe('RunCache', () => {
  it('keys on runId when present', () => {
    const c = new RunCache<number>();
    c.set({ runId: 'r1' }, 42);
    expect(c.get({ runId: 'r1' })).toBe(42);
    expect(c.get({ runId: 'r2' })).toBeUndefined();
  });
  it('falls back to spawnId when no runId', () => {
    const c = new RunCache<number>();
    c.set({ spawnId: 's1' }, 7);
    expect(c.get({ spawnId: 's1' })).toBe(7);
  });
  it('isolates by scope when provided', () => {
    const c = new RunCache<string>();
    c.set({ runId: 'r1' }, 'a', 'public');
    c.set({ runId: 'r1' }, 'b', 'private');
    expect(c.get({ runId: 'r1' }, 'public')).toBe('a');
    expect(c.get({ runId: 'r1' }, 'private')).toBe('b');
  });
  it('LRU-evicts at max size', () => {
    const c = new RunCache<number>(3);
    c.set({ runId: 'r1' }, 1);
    c.set({ runId: 'r2' }, 2);
    c.set({ runId: 'r3' }, 3);
    c.set({ runId: 'r4' }, 4);
    expect(c.get({ runId: 'r1' })).toBeUndefined();
    expect(c.get({ runId: 'r4' })).toBe(4);
    expect(c.size).toBe(3);
  });
});
