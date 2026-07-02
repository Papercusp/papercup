/**
 * rate-limiter-registry — unit tests (WI-253). A thin process-local Map; the teeth are
 * register→get round-trips and unregister actually clearing the entry (so a stopped
 * harness's stale limiter is never served as if still live).
 */
import { describe, it, expect } from 'vitest';
import {
  registerRateLimiter,
  unregisterRateLimiter,
  getRateLimiter,
  rateLimiterRegistrySize,
} from './rate-limiter-registry';
import { MemberRateLimiter } from './rate-limiter';

describe('rate-limiter-registry', () => {
  it('register → get round-trips the SAME instance; a different (workspace, harness) key misses', () => {
    const limiter = new MemberRateLimiter();
    registerRateLimiter('ws-a', 'harness-a', limiter);
    expect(getRateLimiter('ws-a', 'harness-a')).toBe(limiter);
    expect(getRateLimiter('ws-b', 'harness-a')).toBeUndefined();
    expect(getRateLimiter('ws-a', 'harness-b')).toBeUndefined();
    unregisterRateLimiter('ws-a', 'harness-a');
  });

  it('TEETH: unregister clears the entry — a stopped harness reports undefined, not the stale instance', () => {
    const limiter = new MemberRateLimiter();
    registerRateLimiter('ws-c', 'harness-c', limiter);
    expect(getRateLimiter('ws-c', 'harness-c')).toBe(limiter);
    unregisterRateLimiter('ws-c', 'harness-c');
    expect(getRateLimiter('ws-c', 'harness-c')).toBeUndefined();
  });

  it('unregistering a never-registered key is a no-op (never throws)', () => {
    expect(() => unregisterRateLimiter('ws-nope', 'harness-nope')).not.toThrow();
  });

  it('re-registering the same key overwrites the entry', () => {
    const first = new MemberRateLimiter();
    const second = new MemberRateLimiter();
    registerRateLimiter('ws-d', 'harness-d', first);
    registerRateLimiter('ws-d', 'harness-d', second);
    expect(getRateLimiter('ws-d', 'harness-d')).toBe(second);
    unregisterRateLimiter('ws-d', 'harness-d');
  });

  it('size reflects net register/unregister calls', () => {
    const before = rateLimiterRegistrySize();
    registerRateLimiter('ws-e', 'harness-e', new MemberRateLimiter());
    expect(rateLimiterRegistrySize()).toBe(before + 1);
    unregisterRateLimiter('ws-e', 'harness-e');
    expect(rateLimiterRegistrySize()).toBe(before);
  });
});
