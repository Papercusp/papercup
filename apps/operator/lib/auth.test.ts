/**
 * Integration tests for the local-account auth lib. Exercises the
 * full bcrypt round-trip + session lookup + change-password contract
 * against a live embedded-pg. Skipped when PG isn't reachable so the
 * suite stays green on machines without it.
 *
 * Why integration vs pure-unit: lib/auth.ts is end-to-end SQL — there
 * are no separable pure paths to unit-test. The bugs that actually
 * happen here (pg client field shape, bcrypt verify wiring, session
 * TTL stored as Date vs ISO) only surface against real PG.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

let pgReachable = false;
let authMod: typeof import('./auth') | null = null;

beforeAll(async () => {
  try {
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    await c.query('SELECT 1 FROM harness_shared.users LIMIT 1');
    await c.end();
    pgReachable = true;
  } catch {
    pgReachable = false;
  }
  if (pgReachable) {
    authMod = await import('./auth');
    // Drizzle schema-import path errors on first call when called
    // mid-test under vitest's worker. Warm-up via a known-no-op so the
    // first real signup doesn't race the init.
    try { await authMod.getSessionUserOrDefault(); } catch { /* ok */ }
  }
});

const itPg = (name: string, fn: () => Promise<void> | void) => {
  it(name, async () => {
    if (!pgReachable || !authMod) {
      // Soft-skip so CI without embedded-pg stays green.
      return;
    }
    await fn();
  });
};

describe('auth.ts integration', () => {
  const uname = () => `vitest_${randomBytes(4).toString('hex')}`;

  itPg('signup creates user and login returns a session token', async () => {
    const name = uname();
    const user = await authMod!.signup(name, 'Test User', 'sup3rsecret');
    expect(user.username).toBe(name);
    expect(user.has_password).toBe(true);
    const session = await authMod!.login(name, 'sup3rsecret');
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(session.user.id).toBe(user.id);
    expect(session.expires_at).toBeInstanceOf(Date);
    await authMod!.logout(session.token);
  });

  itPg('login rejects wrong password with code bad_password', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'right');
    try {
      await authMod!.login(name, 'wrong');
      expect.fail('login should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('bad_password');
    }
  });

  itPg('login rejects unknown user with code unknown_user', async () => {
    try {
      await authMod!.login('does_not_exist_' + randomBytes(4).toString('hex'), 'x');
      expect.fail('login should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('unknown_user');
    }
  });

  itPg('passwordless user logs in with null password', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', null);
    const session = await authMod!.login(name, null);
    expect(session.user.has_password).toBe(false);
    await authMod!.logout(session.token);
  });

  itPg('password-required user rejects null password', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'x');
    try {
      await authMod!.login(name, null);
      expect.fail('login should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('bad_password');
    }
  });

  itPg('logout deletes the session row', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'x');
    const session = await authMod!.login(name, 'x');
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      const before = await c.query('SELECT 1 FROM harness_shared.user_sessions WHERE token=$1', [session.token]);
      expect(before.rowCount).toBe(1);
      await authMod!.logout(session.token);
      const after = await c.query('SELECT 1 FROM harness_shared.user_sessions WHERE token=$1', [session.token]);
      expect(after.rowCount).toBe(0);
    } finally {
      await c.end();
    }
  });

  itPg('changePassword invalidates ALL existing sessions (the route re-issues)', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'old');
    const s1 = await authMod!.login(name, 'old');
    const s2 = await authMod!.login(name, 'old');
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      const before = await c.query(
        'SELECT COUNT(*)::int n FROM harness_shared.user_sessions WHERE token IN ($1,$2)',
        [s1.token, s2.token],
      );
      expect(before.rows[0].n).toBe(2);
      await authMod!.changePassword(s1.user.id, 'old', 'new');
      const after = await c.query(
        'SELECT COUNT(*)::int n FROM harness_shared.user_sessions WHERE token IN ($1,$2)',
        [s1.token, s2.token],
      );
      expect(after.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  itPg('changePassword requires the current password', async () => {
    const name = uname();
    const created = await authMod!.signup(name, 'T', 'old');
    try {
      await authMod!.changePassword(created.id, 'wrong', 'new');
      expect.fail('changePassword should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('bad_password');
    }
    // After successful change, old password no longer works
    await authMod!.changePassword(created.id, 'old', 'new');
    try {
      await authMod!.login(name, 'old');
      expect.fail('login should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('bad_password');
    }
    const ok = await authMod!.login(name, 'new');
    expect(ok.token).toBeTruthy();
    await authMod!.logout(ok.token);
  });

  itPg('session TTL is stored as a real timestamptz (regression for the Date/ISO bug)', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'x');
    const session = await authMod!.login(name, 'x');
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      const r = await c.query<{ expires_at: Date }>(
        'SELECT expires_at FROM harness_shared.user_sessions WHERE token=$1', [session.token],
      );
      expect(r.rows[0].expires_at).toBeInstanceOf(Date);
      // Within 1 minute of expected 30d-from-now
      const expected = Date.now() + 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(r.rows[0].expires_at.getTime() - expected)).toBeLessThan(60_000);
      await authMod!.logout(session.token);
    } finally {
      await c.end();
    }
  });
});
