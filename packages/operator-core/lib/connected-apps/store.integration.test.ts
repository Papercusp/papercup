/**
 * store.integration.test.ts — app keys in harness_shared.connected_apps against
 * REAL Postgres with every migration applied (1244 included) and REAL RLS
 * (external-app-access-to-workspaces-2026-09-29 P-002).
 *
 * R-8: a database dump yields no usable key. createAppKey returns the full key
 * once; the row keeps sha256(key) in token_hash and NO column holds the key or
 * its secret. The test reads the whole row back through row_to_json, so a
 * column added later that leaks the secret fails here too.
 *
 * Harness shape copied from ../device-store.integration.test.ts:
 *   - withWorkspace runs its callback in an appSql (harness_app, RLS-subject)
 *     transaction with the workspace GUC set, so list/pause/revoke are bounded
 *     by the real workspace policy;
 *   - getOrgPg().sql is the admin (RLS-bypass) client, which verifyAppKey uses
 *     because it must resolve a key before it knows the workspace.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any, adminSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
  getOrgPg: () => ({ sql: h.adminSql }),
}));

const { createAppKey, listAppKeys, setAppKeyPaused, revokeAppKey, verifyAppKey, recordAppKeyUse } =
  await import('./store');
const { parseAppKey } = await import('./key');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let n = 0;
const freshWs = () => `app_ws_${++n}_${randomBytes(2).toString('hex')}`;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('connected-apps store (real PG + real RLS)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('R-8: stores sha256(key) and no column carries the key or its secret', async () => {
    const ws = freshWs();
    const { app, key } = await createAppKey({
      workspaceId: ws,
      userEmail: 'owner@example.test',
      label: 'r8 probe',
      capabilities: ['plans:read', 'plans:read'],
    });
    const { secret } = parseAppKey(key)!;

    expect(app.kind).toBe('app');
    expect(app.scopes).toEqual({ capabilities: ['plans:read'] });
    // The returned row never carries token_hash.
    expect(Object.keys(app)).not.toContain('token_hash');

    const [row] = await h.adminSql`
      SELECT token_hash, row_to_json(c)::text AS whole
        FROM harness_shared.connected_apps c
       WHERE id = ${app.id}
    `;
    expect(row.token_hash).toBe(sha256(key));
    expect(row.whole.includes(secret)).toBe(false);
    expect(row.whole.includes(key)).toBe(false);
    // Positive control: the serialization really does contain the row, so the
    // two absence checks above are measuring something.
    expect(row.whole.includes(app.id)).toBe(true);
    expect(row.whole.includes(row.token_hash)).toBe(true);
  });

  it('verifies a live key and refuses near-misses with a specific reason', async () => {
    const ws = freshWs();
    const { app, key } = await createAppKey({ workspaceId: ws, userEmail: 'o@example.test', label: 'v' });

    const ok = await verifyAppKey(key);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.app.id).toBe(app.id);
      expect(ok.app.workspace_id).toBe(ws);
      expect(Object.keys(ok.app)).not.toContain('token_hash');
    }

    expect(await verifyAppKey('pcapp_not-a-key')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyAppKey(`pcapp_${'Z'.repeat(16)}_${'a'.repeat(43)}`)).toEqual({ ok: false, reason: 'unknown' });
    expect(await verifyAppKey(`pcapp_${app.id}_${'a'.repeat(43)}`)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('pause, resume and revoke take effect on verification; revoke is permanent', async () => {
    const ws = freshWs();
    const { app, key } = await createAppKey({ workspaceId: ws, userEmail: 'o@example.test', label: 'p' });

    expect(await setAppKeyPaused(ws, app.id, true)).toBe(true);
    expect(await verifyAppKey(key)).toEqual({ ok: false, reason: 'paused' });
    expect(await setAppKeyPaused(ws, app.id, false)).toBe(true);
    expect((await verifyAppKey(key)).ok).toBe(true);

    expect(await revokeAppKey(ws, app.id)).toBe(true);
    expect(await verifyAppKey(key)).toEqual({ ok: false, reason: 'revoked' });
    // A revoked key cannot be revoked again, resumed, or paused.
    expect(await revokeAppKey(ws, app.id)).toBe(false);
    expect(await setAppKeyPaused(ws, app.id, false)).toBe(false);
    expect(await verifyAppKey(key)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses a key at or past its expiry', async () => {
    const ws = freshWs();
    const expiresAt = new Date(Date.now() + 60_000);
    const { key } = await createAppKey({ workspaceId: ws, userEmail: 'o@example.test', label: 'e', expiresAt });
    expect((await verifyAppKey(key, new Date(expiresAt.getTime() - 1))).ok).toBe(true);
    expect(await verifyAppKey(key, expiresAt)).toEqual({ ok: false, reason: 'expired' });
  });

  it('workspace RLS bounds management: another workspace can neither list nor revoke the key', async () => {
    const wsA = freshWs();
    const wsB = freshWs();
    const { app, key } = await createAppKey({ workspaceId: wsA, userEmail: 'o@example.test', label: 'rls' });

    expect((await listAppKeys(wsA)).map((r) => r.id)).toContain(app.id);
    expect((await listAppKeys(wsB)).map((r) => r.id)).not.toContain(app.id);
    expect(await revokeAppKey(wsB, app.id)).toBe(false);
    expect(await setAppKeyPaused(wsB, app.id, true)).toBe(false);
    expect((await verifyAppKey(key)).ok).toBe(true);
  });

  it('a kind=mobile row never verifies as an app key, even with a matching digest', async () => {
    const ws = freshWs();
    const id = `M${randomBytes(12).toString('hex').slice(0, 15)}`.replace(/[^A-Za-z0-9]/g, 'x');
    const key = `pcapp_${id}_${'q'.repeat(43)}`;
    await h.adminSql`
      INSERT INTO harness_shared.connected_apps (id, user_email, workspace_id, kind, token_hash)
      VALUES (${id}, 'o@example.test', ${ws}, 'mobile', ${sha256(key)})
    `;
    expect(await verifyAppKey(key)).toEqual({ ok: false, reason: 'unknown' });
    expect((await listAppKeys(ws)).map((r) => r.id)).not.toContain(id);
  });

  it('recordAppKeyUse stamps last_seen and last_ip', async () => {
    const ws = freshWs();
    const { app } = await createAppKey({ workspaceId: ws, userEmail: 'o@example.test', label: 'u' });
    await recordAppKeyUse(app.id, '203.0.113.7');
    const [row] = await h.adminSql`
      SELECT last_seen, last_ip FROM harness_shared.connected_apps WHERE id = ${app.id}
    `;
    expect(row.last_seen).toBeInstanceOf(Date);
    expect(row.last_ip).toBe('203.0.113.7');
  });

  it('the database refuses an app row without a token hash, and a token_hash that is not a digest', async () => {
    const ws = freshWs();
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps (id, user_email, workspace_id, kind)
      VALUES (${`nohash${n}${randomBytes(3).toString('hex')}`}, 'o@example.test', ${ws}, 'app')
    `).rejects.toThrow(/connected_apps_app_has_token_hash/);
    const key = `pcapp_${'R'.repeat(16)}_${'a'.repeat(43)}`;
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps (id, user_email, workspace_id, kind, token_hash)
      VALUES (${`raw${n}${randomBytes(3).toString('hex')}`}, 'o@example.test', ${ws}, 'app', ${key})
    `).rejects.toThrow(/connected_apps_token_hash_shape/);
  });
});
