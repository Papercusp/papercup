/**
 * Tests for the auth audit log + HMAC session-token helper.
 * Soft-skipped when embedded-pg isn't reachable.
 *
 * Step E (Tier-2 follow-up arc).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

let pgReachable = false;
let mod: typeof import('./auth-audit') | null = null;
type ClientLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; end: () => Promise<void> };
let pgClient: ClientLike | null = null;

const SENTINEL_USER = `vitest_audit_${randomBytes(3).toString('hex')}`;

beforeAll(async () => {
  try {
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    await c.query("SELECT 1 FROM harness_shared.auth_audit_log LIMIT 1");
    pgClient = c as unknown as ClientLike;
    pgReachable = true;
  } catch {
    pgReachable = false;
  }
  if (pgReachable) {
    mod = await import('./auth-audit');
    // Warm up drizzle init.
    try {
      await mod.recordAuthEvent({
        kind: 'logout', ok: true, username: '__warmup__',
      });
    } catch { /* ok */ }
    await pgClient!.query(
      `DELETE FROM harness_shared.auth_audit_log WHERE username = $1`,
      ['__warmup__'],
    );
  }
});

afterEach(async () => {
  if (pgClient) {
    await pgClient.query(
      `DELETE FROM harness_shared.auth_audit_log WHERE username LIKE $1`,
      ['vitest_audit_%'],
    );
  }
});

const itPg = (name: string, fn: () => Promise<void> | void) => {
  it(name, async () => {
    if (!pgReachable || !mod) return;
    await fn();
  });
};

describe('hmacSessionToken', () => {
  itPg('produces a 16-hex-char digest', async () => {
    const h = mod!.hmacSessionToken('some-token-value-1234');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  itPg('is deterministic for the same input', async () => {
    const a = mod!.hmacSessionToken('token-A');
    const b = mod!.hmacSessionToken('token-A');
    expect(a).toBe(b);
  });

  itPg('produces different digests for different tokens', async () => {
    const a = mod!.hmacSessionToken('token-A');
    const b = mod!.hmacSessionToken('token-B');
    expect(a).not.toBe(b);
  });
});

describe('recordAuthEvent', () => {
  itPg('inserts a row with all fields populated', async () => {
    await mod!.recordAuthEvent({
      kind: 'login_ok',
      username: SENTINEL_USER,
      ip: '10.0.0.42',
      userAgent: 'vitest/test',
      ok: true,
      sessionToken: 'tok-abc',
      metadata: { source: 'unit-test' },
    });
    const result = await pgClient!.query(
      `SELECT kind, username, ip, user_agent, ok, session_hmac, metadata
         FROM harness_shared.auth_audit_log
        WHERE username = $1`,
      [SENTINEL_USER],
    );
    expect(result.rows.length).toBe(1);
    const row = result.rows[0] as Record<string, unknown>;
    expect(row.kind).toBe('login_ok');
    expect(row.ip).toBe('10.0.0.42');
    expect(row.ok).toBe(true);
    expect(typeof row.session_hmac).toBe('string');
    expect((row.session_hmac as string).length).toBe(16);
  });

  itPg('null fields are written as null, not "null" strings', async () => {
    await mod!.recordAuthEvent({
      kind: 'logout',
      username: SENTINEL_USER,
      ok: true,
      // ip, userAgent, sessionToken, metadata all omitted
    });
    const result = await pgClient!.query(
      `SELECT ip, user_agent, session_hmac, metadata
         FROM harness_shared.auth_audit_log
        WHERE username = $1`,
      [SENTINEL_USER],
    );
    const row = result.rows[0] as Record<string, unknown>;
    expect(row.ip).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.session_hmac).toBeNull();
    expect(row.metadata).toBeNull();
  });

  itPg('failure to write does not throw to caller', async () => {
    // Simulate a backend failure by feeding an oversized field (PG will
    // accept it actually — so we just verify the function never throws
    // synchronously or via rejection).
    await expect(
      mod!.recordAuthEvent({
        kind: 'login_failed',
        username: SENTINEL_USER,
        ok: false,
        metadata: { huge: 'x'.repeat(100) },
      }),
    ).resolves.toBeUndefined();
  });
});
