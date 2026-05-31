/**
 * ratelimit.test.ts — publish-worker abuse limits (Plan 2 Phase A, P-002c).
 *
 * The publish flow is rate-limited per tenant (burst + daily, tiered free/paid)
 * and per IP (publish-daily, register-hourly) via KV counters. These are the
 * abuse-prevention gates; this covers the increment/cap behavior, tier-based cap
 * selection, per-key isolation, the empty-IP skip, and the RateLimitError shape.
 */
import { describe, expect, it } from 'vitest';
import {
  checkTenantBurst,
  checkTenantDaily,
  checkIpPublishDaily,
  RateLimitError,
} from './ratelimit.ts';

class FakeKV {
  store = new Map<string, string>();
  async get(k: string): Promise<string | null> {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string): Promise<void> {
    this.store.set(k, v);
  }
}

const mkEnv = (over: Record<string, string> = {}) =>
  ({
    COUNTERS: new FakeKV(),
    RATE_PER_TENANT_BURST: '3',
    RATE_PER_TENANT_DAILY_FREE: '5',
    RATE_PER_TENANT_DAILY_PAID: '100',
    RATE_PER_IP_PUBLISH_DAILY: '10',
    RATE_PER_IP_REGISTER_HOURLY: '2',
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('rate limiting', () => {
  it('allows calls under the burst cap and increments the counter', async () => {
    const env = mkEnv();
    await checkTenantBurst(env, 't1');
    await checkTenantBurst(env, 't1');
    await checkTenantBurst(env, 't1');
    expect(await env.COUNTERS.get('ratelimit:burst:t1')).toBe('3');
  });

  it('throws RateLimitError once the burst cap is reached', async () => {
    const env = mkEnv();
    for (let i = 0; i < 3; i++) await checkTenantBurst(env, 't1');
    await expect(checkTenantBurst(env, 't1')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('the RateLimitError names its bucket + retry window', async () => {
    const env = mkEnv({ RATE_PER_TENANT_BURST: '0' });
    await expect(checkTenantBurst(env, 't1')).rejects.toMatchObject({
      bucket: 'ratelimit:burst:t1',
      retryAfterSec: 60,
    });
  });

  it('uses the free cap for a free tenant and the paid cap for a paid tenant', async () => {
    const free = mkEnv();
    for (let i = 0; i < 5; i++) await checkTenantDaily(free, 't1', 'free');
    await expect(checkTenantDaily(free, 't1', 'free')).rejects.toBeInstanceOf(RateLimitError);

    const paid = mkEnv();
    for (let i = 0; i < 6; i++) await checkTenantDaily(paid, 't1', 'paid'); // cap 100 — fine
    expect(await paid.COUNTERS.get('ratelimit:daily:t1')).toBe('6');
  });

  it('isolates counters per tenant', async () => {
    const env = mkEnv();
    await checkTenantBurst(env, 'a');
    await checkTenantBurst(env, 'b');
    expect(await env.COUNTERS.get('ratelimit:burst:a')).toBe('1');
    expect(await env.COUNTERS.get('ratelimit:burst:b')).toBe('1');
  });

  it('skips IP limits when the ip is empty, but enforces them for a real ip', async () => {
    const env = mkEnv({ RATE_PER_IP_PUBLISH_DAILY: '0' });
    await expect(checkIpPublishDaily(env, '')).resolves.toBeUndefined(); // empty ip → no-op
    await expect(checkIpPublishDaily(env, '1.2.3.4')).rejects.toBeInstanceOf(RateLimitError); // cap 0 → throws
  });
});
