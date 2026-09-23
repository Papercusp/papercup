import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const SECRET = 'hosted-session-test-secret-is-at-least-32-bytes';
const NOW = new Date('2026-08-23T12:00:00.000Z');
const EXPIRY = new Date('2026-08-23T13:00:00.000Z');

let db: OrgTestDb | null = null;
let dbReady = false;
let mod: typeof import('./hosted-session') | null = null;

beforeAll(async () => {
  const { createOrgTestDb } = await import('../../test/_org-test-db');
  try {
    db = await createOrgTestDb();
  } catch {
    dbReady = false;
  }
  if (db) {
    h.sql = db.adminSql;
    dbReady = true;
  }
  mod = await import('./hosted-session');
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

function input(suffix: string) {
  return {
    userId: `user-${suffix}`,
    organizationId: `org-${suffix}`,
    workspaceId: `workspace-${suffix}`,
    permissionVersion: 4,
    upstreamProvider: 'workos',
    upstreamSessionId: `upstream-${suffix}`,
    expiresAt: EXPIRY,
  };
}

const itPg = (name: string, fn: () => Promise<void>) => {
  it(name, async () => {
    if (!dbReady || !db || !mod) return;
    await fn();
  });
};

describe('HostedSessionCookieCodec', () => {
  it('round-trips a signed opaque id and emits an exact host-only cookie', async () => {
    const m = mod ?? await import('./hosted-session');
    const codec = new m.HostedSessionCookieCodec(SECRET);
    const id = `hs_${'a'.repeat(43)}`;
    const value = codec.encode(id);

    expect(codec.decode(value)).toBe(id);
    expect(codec.read(new Headers({ cookie: `other=x; ${m.HOSTED_SESSION_COOKIE}=${value}` }))).toBe(id);

    const header = codec.serialize(id, EXPIRY, NOW);
    expect(header).toContain(`${m.HOSTED_SESSION_COOKIE}=`);
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=3600');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Domain=');
  });

  it('fails closed for tampering, a different secret, malformed cookies, and weak secrets', async () => {
    const m = mod ?? await import('./hosted-session');
    const codec = new m.HostedSessionCookieCodec(SECRET);
    const id = `hs_${'b'.repeat(43)}`;
    const value = codec.encode(id);

    expect(codec.decode(`${value.slice(0, -1)}x`)).toBeNull();
    expect(new m.HostedSessionCookieCodec(`${SECRET}-different`).decode(value)).toBeNull();
    expect(codec.read(new Headers({ cookie: `${m.HOSTED_SESSION_COOKIE}=%E0%A4%A` }))).toBeNull();
    expect(() => new m.HostedSessionCookieCodec('short')).toThrowError(
      expect.objectContaining({ code: 'hosted_session_cookie_secret_invalid' }),
    );

    const deletion = codec.delete();
    expect(deletion).toContain('Max-Age=0');
    expect(deletion).toContain('HttpOnly');
    expect(deletion).toContain('Secure');
    expect(deletion).not.toContain('Domain=');
  });
});

describe('HostedSessionStore', () => {
  itPg('creates and resolves only an active, version-matching tenant-bound session', async () => {
    const store = new mod!.HostedSessionStore(h.sql, () => NOW);
    const session = await store.create(input('create'));

    expect(session).toMatchObject({
      userId: 'user-create',
      organizationId: 'org-create',
      workspaceId: 'workspace-create',
      permissionVersion: 4,
      upstreamProvider: 'workos',
      upstreamSessionId: 'upstream-create',
      revokedAt: null,
    });
    expect(session.id).toMatch(/^hs_[A-Za-z0-9_-]{43}$/);
    expect(await store.resolve(session.id, { at: NOW, expectedPermissionVersion: 4 })).toMatchObject({
      id: session.id,
    });
    expect(await store.resolve(session.id, { at: NOW, expectedPermissionVersion: 5 })).toBeNull();

    const rows = await db!.adminSql<Array<Record<string, unknown>>>`
      SELECT * FROM papercusp_auth.hosted_sessions WHERE id = ${session.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('capabilities');
    expect(rows[0]).not.toHaveProperty('permissions');
    expect(rows[0]).not.toHaveProperty('token');
    expect(rows[0]).not.toHaveProperty('token_digest');
  });

  itPg('rejects wildcard/session-carried authority and already-expired issues before SQL', async () => {
    const store = new mod!.HostedSessionStore(h.sql, () => NOW);
    await expect(store.create({ ...input('wildcard'), capabilities: ['*'] } as any)).rejects.toMatchObject({
      code: 'hosted_session_authority_forbidden',
    });
    await expect(store.create({ ...input('expired'), expiresAt: new Date(NOW.getTime() - 1) })).rejects.toMatchObject({
      code: 'hosted_session_expired',
    });
  });

  itPg('rotates atomically in-place, invalidates the old id, and can refresh tenant claims', async () => {
    const store = new mod!.HostedSessionStore(h.sql, () => NOW);
    const original = await store.create(input('rotate'));
    const rotatedAt = new Date(NOW.getTime() + 1_000);
    const rotated = await store.rotate(original.id, {
      at: rotatedAt,
      expectedPermissionVersion: 4,
      permissionVersion: 5,
      workspaceId: null,
      expiresAt: new Date(EXPIRY.getTime() + 60_000),
    });

    expect(rotated).toMatchObject({
      userId: original.userId,
      organizationId: original.organizationId,
      workspaceId: null,
      permissionVersion: 5,
      upstreamSessionId: original.upstreamSessionId,
    });
    expect(rotated!.id).not.toBe(original.id);
    expect(rotated!.rotatedAt?.toISOString()).toBe(rotatedAt.toISOString());
    expect(await store.resolve(original.id, { at: rotatedAt })).toBeNull();
    expect(await store.resolve(rotated!.id, { at: rotatedAt, expectedPermissionVersion: 5 })).not.toBeNull();

    const count = await db!.adminSql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM papercusp_auth.hosted_sessions
       WHERE upstream_provider = 'workos'
         AND upstream_session_id = 'upstream-rotate'`;
    expect(count[0].count).toBe(1);
  });

  // Workspace selection builds the store on the hosted service context's OPEN transaction,
  // which has no `.begin()`. rotate threw `this.sql.begin is not a function` there, so every
  // selection 500'd live (2026-09-23) while the pool-backed test above stayed green.
  itPg('rotates on a store built from a caller\'s open transaction', async () => {
    const original = await new mod!.HostedSessionStore(h.sql, () => NOW).create(input('rotate-in-tx'));
    const rotated = await h.sql.begin((tx: any) => {
      expect('begin' in tx).toBe(false);
      return new mod!.HostedSessionStore(tx, () => NOW).rotate(original.id, {
        expectedPermissionVersion: 4,
        workspaceId: 'workspace-selected',
      });
    });

    expect(rotated).toMatchObject({ workspaceId: 'workspace-selected', permissionVersion: 4 });
    expect(rotated!.id).not.toBe(original.id);
    const store = new mod!.HostedSessionStore(h.sql, () => NOW);
    expect(await store.resolve(original.id, { at: NOW })).toBeNull();
    expect(await store.resolve(rotated!.id, { at: NOW })).toMatchObject({ workspaceId: 'workspace-selected' });
  });

  itPg('signing in again on a reused provider session supersedes only the same user\'s earlier session', async () => {
    const store = new mod!.HostedSessionStore(h.sql, () => NOW);
    const first = await store.create(input('reauth'));
    // Same person, same upstream session id — what WorkOS returns when its own
    // browser session outlives our 5-minute local session (2026-09-23 incident).
    const second = await store.create(input('reauth'));

    expect(second.id).not.toBe(first.id);
    expect(await store.resolve(first.id, { at: NOW })).toBeNull();
    expect(await store.resolve(second.id, { at: NOW })).toMatchObject({ id: second.id });
    const rows = await db!.adminSql<Array<{ id: string; revocation_reason: string | null }>>`
      SELECT id, revocation_reason FROM papercusp_auth.hosted_sessions
       WHERE upstream_provider = 'workos' AND upstream_session_id = 'upstream-reauth'
       ORDER BY created_at, revoked_at NULLS LAST`;
    expect(rows).toEqual([
      { id: first.id, revocation_reason: 'superseded_by_reauthentication' },
      { id: second.id, revocation_reason: null },
    ]);

    // A DIFFERENT user presenting the same upstream session id must not retire
    // the live owner's session, and must not get one of its own.
    await expect(store.create({ ...input('reauth'), userId: 'user-intruder' })).rejects.toThrow(
      /hosted_sessions_upstream_session_key/,
    );
    expect(await store.resolve(second.id, { at: NOW })).toMatchObject({ id: second.id });
  });

  itPg('revokes by opaque id or provider session and never resolves expired rows', async () => {
    const store = new mod!.HostedSessionStore(h.sql, () => NOW);
    const direct = await store.create(input('direct-revoke'));
    expect(await store.revoke(direct.id, 'logout', NOW)).toBe(true);
    expect(await store.revoke(direct.id, 'logout', NOW)).toBe(false);
    expect(await store.resolve(direct.id, { at: NOW })).toBeNull();

    const upstream = await store.create(input('upstream-revoke'));
    expect(await store.revokeByUpstreamSession('workos', upstream.upstreamSessionId, 'provider_logout', NOW)).toBe(1);
    expect(await store.resolve(upstream.id, { at: NOW })).toBeNull();

    const expiring = await store.create(input('expiry'));
    expect(await store.resolve(expiring.id, { at: new Date(EXPIRY.getTime() + 1) })).toBeNull();
  });
});
