import { describe, expect, it } from 'vitest';
import {
  DELTA_PROXY_SESSION_MAX_ENTRIES,
  DELTA_PROXY_SESSION_TTL_MS,
  DeltaProxySessionStore,
} from './delta-proxy-session-store';

describe('DeltaProxySessionStore', () => {
  it('reuses a live session and expires it after the cursor retention window', () => {
    let now = 1_000;
    const store = new DeltaProxySessionStore({ ttlMs: 100, now: () => now });

    const first = store.getOrCreate('session-a');
    expect(store.getOrCreate('session-a')).toBe(first);
    expect(store.size).toBe(1);

    now = 1_100;
    const refreshed = store.getOrCreate('session-a');
    expect(refreshed).not.toBe(first);
    expect(store.size).toBe(1);
  });

  it('evicts the oldest session when the process-local bound is reached', () => {
    let now = 1_000;
    const store = new DeltaProxySessionStore({ maxEntries: 2, ttlMs: 10_000, now: () => now });

    const first = store.getOrCreate('session-a');
    now += 1;
    const second = store.getOrCreate('session-b');
    now += 1;
    const third = store.getOrCreate('session-c');

    expect(store.size).toBe(2);
    expect(store.getOrCreate('session-b')).toBe(second);
    expect(store.getOrCreate('session-c')).toBe(third);
    expect(store.getOrCreate('session-a')).not.toBe(first);
  });

  it('uses bounded defaults aligned with the delta cursor lifetime', () => {
    expect(DELTA_PROXY_SESSION_TTL_MS).toBe(5 * 60_000);
    expect(DELTA_PROXY_SESSION_MAX_ENTRIES).toBe(1024);
  });
});
