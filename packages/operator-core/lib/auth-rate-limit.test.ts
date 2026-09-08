/**
 * Unit-tier tests for the two-bucket auth rate limit, against a REAL but
 * ISOLATED Postgres — a throwaway, fully-migrated database cloned per run
 * from a cached testcontainers template (see `createOrgTestDb`,
 * `../test/_org-test-db.ts`), dropped in `afterAll`.
 *
 * EI-19318128948371877 (decision B, same fix as `auth.test.ts` — WI-6877
 * named this file as the sibling of that pattern): this file used to run its
 * queries directly against the shared LIVE dev embedded-pg (a raw `pg.Client`
 * probe + `delete process.env.PAPERCUSP_FORBID_REAL_PG` opt-out), hitting
 * `harness_shared.auth_rate_limit` on the box every concurrent fleet agent
 * shares. It now stands up its OWN throwaway database per run and drops it
 * afterward — see `auth.test.ts` for the full rationale (this file mirrors it
 * exactly).
 *
 * Step E (Tier-2 follow-up arc).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as any }));

// Mirrors auth.test.ts / user-preferences.integration.test.ts's mock shape —
// auth-rate-limit.ts only ever destructures `{ sql }` from getOrgPg() (grep
// confirms 5/5 call sites), so this is a faithful stand-in.
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

let db: OrgTestDb | null = null;
let dbReady = false;
let mod: typeof import('./auth-rate-limit') | null = null;

beforeAll(async () => {
  const { createOrgTestDb } = await import('../test/_org-test-db');
  try {
    db = await createOrgTestDb();
  } catch {
    // Soft-skip, mirroring this file's previous "no PG reachable" contract —
    // now "no Docker/testcontainer reachable". See auth.test.ts for detail.
    dbReady = false;
    return;
  }
  h.sql = db.adminSql;
  dbReady = true;
  mod = await import('./auth-rate-limit');
  try { await mod.checkSoftPerIp('warmup'); } catch { /* ok */ }
  try { await mod._clearAllForKeyPrefix('ip:warmup'); } catch { /* */ }
  // 180s: see auth.test.ts — a cold template build comfortably exceeds the
  // unit layer's 60s default hookTimeout; every later run clones it near-instant.
}, 180_000);

afterEach(async () => {
  if (mod) {
    await mod._clearAllForKeyPrefix('ip:').catch(() => {});
    await mod._clearAllForKeyPrefix('user:').catch(() => {});
    await mod._clearAllForKeyPrefix('account:').catch(() => {});
    await mod._clearAllForKeyPrefix('global:').catch(() => {});
  }
});

afterAll(async () => {
  await db?.cleanup();
});

const itPg = (name: string, fn: () => Promise<void> | void) => {
  it(name, async () => {
    if (!dbReady || !mod) return;
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

describe('account-wide hard bucket', () => {
  itPg('locks the same account across changing source addresses', async () => {
    const user = `vitest_${randomBytes(3).toString('hex')}`;
    for (let i = 0; i < mod!.RATE_LIMIT_CONSTANTS.HARD_CAPACITY; i += 1) {
      await mod!.burnHardPerAccount(user);
    }
    expect((await mod!.checkHardPerAccount(user)).ok).toBe(false);
    expect((await mod!.checkHardPerAccount(user.toUpperCase())).ok).toBe(false);
    await mod!.resetHardPerAccount(user);
    expect((await mod!.checkHardPerAccount(user)).ok).toBe(true);
  });
});

describe('global soft login budget', () => {
  itPg('enforces the configured capacity and refunds a successful login slot', async () => {
    // The generic @papercusp/rate-limit suite exhaustively walks every slot.
    // Seed this PG-backed adapter at capacity-1 so this integration test still
    // proves the global key/configuration + refund boundary without performing
    // 100 serialized GC/read/write cycles (which exceeded Vitest's 60s test
    // timeout under fleet load).
    const now = Date.now();
    const recent = Array.from(
      { length: mod!.RATE_LIMIT_CONSTANTS.GLOBAL_CAPACITY - 1 },
      () => now,
    );
    await h.sql`
      INSERT INTO harness_shared.auth_rate_limit (key, payload, updated_at)
      VALUES ('global:login', ${JSON.stringify({ recent, lockedUntilMs: 0 })}::text::jsonb, ${now})
      ON CONFLICT (key) DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at
    `;
    expect((await mod!.checkSoftGlobal()).ok).toBe(true);
    expect((await mod!.checkSoftGlobal()).ok).toBe(false);
    await mod!.refundSoftGlobal();
    expect((await mod!.checkSoftGlobal()).ok).toBe(true);
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
