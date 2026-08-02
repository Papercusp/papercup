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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';

let pgReachable = false;
let authMod: typeof import('./auth') | null = null;

// EI-12970: every uname() below feeds a signup() call, which INSERTs a
// permanent row into harness_shared.users. Unlike the session rows this
// file cleans up per-test, nothing ever deleted the user rows themselves —
// this suite alone leaked ~29k debris rows into the live dev PG (this file
// intentionally targets the real embedded-pg, not testcontainers; see the
// module docstring). Track every username this run creates and delete them
// in afterAll below.
const createdUsernames: string[] = [];

beforeAll(async () => {
  // EI-19311807188719573 / WI-6915: the unit layer sets PAPERCUSP_FORBID_REAL_PG=1, which
  // makes buildClient() throw on any real pool. This file DELIBERATELY targets the live
  // embedded-pg (see the module docstring) — lib/auth.ts is end-to-end SQL with no
  // separable pure paths — so it takes the documented per-file opt-out from
  // libs/test-config/src/setup-no-real-pg.ts: delete the var in our own beforeAll, which
  // runs AFTER that module-level set and therefore wins.
  //
  // Why the file's own pgReachable guard could NOT absorb this: the probe below opens a
  // RAW `pg` Client, which the rail does not guard (it guards buildClient, the shared-pool
  // choke point). So the probe succeeded, pgReachable stayed true, and the rail then threw
  // inside lib/auth.ts — 28 hard failures across this file and its siblings, red-pinning
  // the fleet gate. A reachability probe that does not travel the same path as the code
  // under test cannot gate that code.
  delete process.env.PAPERCUSP_FORBID_REAL_PG;
  try {
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    await c.query('SELECT 1 FROM harness_shared.users LIMIT 1');
    // Self-heal: sweep STALE ('vitest_%' older than 2h) debris on every run
    // so the historical backlog (and any future regression of the cleanup
    // below) drains automatically without a separate scheduled job. The 2h
    // floor is well past any single test run, so it never touches a
    // concurrent in-flight run's fresh rows on this heavily-parallel
    // shared dev box.
    await c.query(
      `DELETE FROM harness_shared.users
        WHERE username LIKE 'vitest_%'
          AND created_at < now() - interval '2 hours'`,
    );
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

afterAll(async () => {
  if (!pgReachable || createdUsernames.length === 0) return;
  const { pgClientFields } = await import('./memory/mem0-connection');
  const fields = await pgClientFields();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg') as typeof import('pg');
  const c = new Client(fields);
  await c.connect();
  try {
    await c.query('DELETE FROM harness_shared.users WHERE username = ANY($1)', [
      createdUsernames,
    ]);
  } finally {
    await c.end();
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
  const uname = () => {
    const n = `vitest_${randomBytes(4).toString('hex')}`;
    createdUsernames.push(n);
    return n;
  };

  // EI-12970 recurrence guard (part 4 of the fix): the beforeAll self-heal
  // sweep above already deleted every 'vitest_%' row older than 2h for THIS
  // run, so right now there should be exactly zero stale rows regardless of
  // how many concurrent fleet test runs are mid-flight (their own rows are
  // all fresh, not stale). A regression that breaks the sweep (wrong table,
  // wrong predicate, sweep silently failing) makes this fail immediately
  // instead of debris quietly re-accumulating to another 29k rows. The total
  // (fresh + stale) count is bounded generously so normal concurrent-run
  // noise never flags it, while a full-blown regression still would.
  itPg('EI-12970 regression guard: vitest_* debris in harness_shared.users stays bounded', async () => {
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      const stale = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM harness_shared.users
          WHERE username LIKE 'vitest_%' AND created_at < now() - interval '2 hours'`,
      );
      expect(Number(stale.rows[0]!.n)).toBe(0);
      const total = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM harness_shared.users WHERE username LIKE 'vitest_%'`,
      );
      expect(Number(total.rows[0]!.n)).toBeLessThan(2000);
    } finally {
      await c.end();
    }
  });

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

  itPg('login sweeps expired + stale never-reused sessions, keeps active ones (EI-338)', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'pw');
    const s1 = await authMod!.login(name, 'pw');
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    const tok = () => randomBytes(32).toString('hex');
    const expired = tok();
    const orphan = tok();
    const oldActive = tok();
    try {
      // expired outright
      await c.query(
        `INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, created_at)
         VALUES ($1, $2, now() - interval '1 hour', now() - interval '31 days')`,
        [expired, s1.user.id],
      );
      // in-TTL but never re-presented since mint and past the 48h grace —
      // the EI-338 orphan signature (cookie-less webview mints leave
      // last_seen_at == created_at; the column is NOT NULL)
      await c.query(
        `INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, created_at, last_seen_at)
         VALUES ($1, $2, now() + interval '29 days', now() - interval '3 days', now() - interval '3 days')`,
        [orphan, s1.user.id],
      );
      // old but actively used — last_seen_at refresh must protect it
      await c.query(
        `INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, created_at, last_seen_at)
         VALUES ($1, $2, now() + interval '29 days', now() - interval '3 days', now() - interval '5 minutes')`,
        [oldActive, s1.user.id],
      );
      const s2 = await authMod!.login(name, 'pw'); // triggers the opportunistic sweep
      const left = await c.query(
        'SELECT token FROM harness_shared.user_sessions WHERE token = ANY($1)',
        [[expired, orphan, oldActive, s1.token]],
      );
      const survivors = left.rows.map((r: { token: string }) => r.token).sort();
      expect(survivors).toEqual([oldActive, s1.token].sort());
      await authMod!.logout(s2.token);
    } finally {
      await c.query('DELETE FROM harness_shared.user_sessions WHERE token = ANY($1)', [
        [expired, orphan, oldActive, s1.token],
      ]);
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
