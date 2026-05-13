/**
 * Integration tests for the two-bucket auth rate limit.
 * Soft-skipped when embedded-pg isn't reachable (auth.test.ts pattern).
 *
 * Step E (Tier-2 follow-up arc).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

let pgReachable = false;
let mod: typeof import('./auth-rate-limit') | null = null;

beforeAll(async () => {
  try {
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    await c.query("SELECT 1 FROM harness_shared.auth_rate_limit LIMIT 1");
    await c.end();
    pgReachable = true;
  } catch {
    pgReachable = false;
  }
  if (pgReachable) {
    mod = await import('./auth-rate-limit');
    try { await mod.checkSoftPerIp('warmup'); } catch { /* ok */ }
    try { await mod._clearAllForKeyPrefix('ip:warmup'); } catch { /* */ }
  }
});

afterEach(async () => {
  if (mod) {
    await mod._clearAllForKeyPrefix('ip:').catch(() => {});
    await mod._clearAllForKeyPrefix('user:').catch(() => {});
  }
});

const itPg = (name: string, fn: () => Promise<void> | void) => {
  it(name, async () => {
    if (!pgReachable || !mod) return;
    await fn();
  });
};

function randIp() {
  // Non-loopback range so soft bucket actually applies.
  return `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
}

describe('soft per-IP bucket', () => {
  itPg('allows up to capacity from a single non-loopback IP', async () => {
    const ip = randIp();
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.SOFT_CAPACITY; i += 1) {
      const r = await mod!.checkSoftPerIp(ip);
      expect(r.ok, `attempt ${i + 1} should be allowed`).toBe(true);
    }
  });

  itPg('blocks the (capacity+1)th attempt with retryAfterS', async () => {
    const ip = randIp();
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.SOFT_CAPACITY; i += 1) {
      await mod!.checkSoftPerIp(ip);
    }
    const blocked = await mod!.checkSoftPerIp(ip);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterS).toBeGreaterThan(0);
  });

  itPg('exempts loopback IP entirely', async () => {
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.SOFT_CAPACITY * 5; i += 1) {
      const r = await mod!.checkSoftPerIp('127.0.0.1');
      expect(r.ok).toBe(true);
    }
  });

  itPg('refundSoftPerIp pops the most recent attempt', async () => {
    const ip = randIp();
    // Burn capacity-1 + refund + try once more.
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.SOFT_CAPACITY - 1; i += 1) {
      await mod!.checkSoftPerIp(ip);
    }
    await mod!.refundSoftPerIp(ip);
    // Now we should be at capacity-2; two more attempts allowed.
    const r1 = await mod!.checkSoftPerIp(ip);
    expect(r1.ok).toBe(true);
    const r2 = await mod!.checkSoftPerIp(ip);
    expect(r2.ok).toBe(true);
  });
});

describe('hard per-(IP, username) bucket', () => {
  itPg('allows attempts before the capacity', async () => {
    const ip = randIp();
    const user = `vitest_${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.HARD_CAPACITY; i += 1) {
      const r = await mod!.checkHardPerUser(ip, user);
      expect(r.ok, `attempt ${i + 1}`).toBe(true);
      await mod!.burnHardPerUser(ip, user); // simulate a failure burn
    }
  });

  itPg('locks out after capacity burns', async () => {
    const ip = randIp();
    const user = `vitest_${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.HARD_CAPACITY; i += 1) {
      await mod!.burnHardPerUser(ip, user);
    }
    const r = await mod!.checkHardPerUser(ip, user);
    expect(r.ok).toBe(false);
    expect(r.retryAfterS).toBeGreaterThan(0);
  });

  itPg('resetHardPerUser clears the bucket', async () => {
    const ip = randIp();
    const user = `vitest_${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.HARD_CAPACITY; i += 1) {
      await mod!.burnHardPerUser(ip, user);
    }
    // Confirm locked.
    expect((await mod!.checkHardPerUser(ip, user)).ok).toBe(false);
    // Reset.
    await mod!.resetHardPerUser(ip, user);
    expect((await mod!.checkHardPerUser(ip, user)).ok).toBe(true);
  });

  itPg('applies on loopback (username-scoped, not IP-scoped)', async () => {
    const user = `vitest_${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.HARD_CAPACITY; i += 1) {
      await mod!.burnHardPerUser('127.0.0.1', user);
    }
    const r = await mod!.checkHardPerUser('127.0.0.1', user);
    expect(r.ok).toBe(false);
  });
});

describe('isLoopbackIp', () => {
  it('recognizes 127.0.0.1, ::1, localhost', async () => {
    const m = await import('./auth-rate-limit');
    expect(m.isLoopbackIp('127.0.0.1')).toBe(true);
    expect(m.isLoopbackIp('::1')).toBe(true);
    expect(m.isLoopbackIp('localhost')).toBe(true);
    expect(m.isLoopbackIp('10.0.0.1')).toBe(false);
    expect(m.isLoopbackIp('')).toBe(false);
    expect(m.isLoopbackIp(null)).toBe(false);
  });

  it('takes the leftmost entry from an x-forwarded-for chain', async () => {
    const m = await import('./auth-rate-limit');
    expect(m.isLoopbackIp('127.0.0.1, 10.0.0.5')).toBe(true);
    expect(m.isLoopbackIp('10.0.0.5, 127.0.0.1')).toBe(false);
  });
});
