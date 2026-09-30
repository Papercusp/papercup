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

const {
  createAppKey,
  createServiceKey,
  listAppKeys,
  setAppKeyPaused,
  revokeAppKey,
  rotateAppKey,
  verifyAppKey,
  recordAppKeyUse,
} = await import('./store');
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

  it('P-324: the 1244 deploy-window view mobile_devices is gone once every migration applies (1272), and connected_apps remains', async () => {
    // New code must reach phones through connected_apps. A reintroduced shim under the old
    // name would let pre-rename code keep working unnoticed, so its absence is asserted.
    const [row] = await h.adminSql`
      SELECT to_regclass('harness_shared.mobile_devices') IS NULL     AS shim_gone,
             to_regclass('harness_shared.connected_apps') IS NOT NULL AS table_present
    `;
    // Booleans, not regclass::text: that prints unqualified names whenever harness_shared is
    // on the search_path.
    expect(row.shim_gone).toBe(true);
    expect(row.table_present).toBe(true);
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

  // ── P-015 (migration 1252): service keys, rotation overlap, spending caps ──────────────────

  it('R-10/R-13: a service key persists as kind=service with its spending cap and verifies', async () => {
    const ws = freshWs();
    const { app, key } = await createServiceKey({
      workspaceId: ws,
      userEmail: 'creator@example.test',
      label: 'nightly sync',
      spendCapCents: 2_500,
    });
    const [row] = await h.adminSql`
      SELECT kind, spend_cap_cents::float8 AS cap, spend_cap_window_sec, expires_at
        FROM harness_shared.connected_apps WHERE id = ${app.id}
    `;
    expect(row).toMatchObject({ kind: 'service', cap: 2_500, spend_cap_window_sec: 30 * 24 * 60 * 60, expires_at: null });
    const verdict = await verifyAppKey(key);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.app.kind).toBe('service');
    expect((await listAppKeys(ws)).map((k) => k.id)).toContain(app.id);
  });

  it('R-11/R-12: rotation keeps the old secret valid inside the window, refuses it after, and stores digests only', async () => {
    const ws = freshWs();
    const { app, key: oldKey } = await createServiceKey({
      workspaceId: ws,
      userEmail: 'creator@example.test',
      label: 'rotating',
      spendCapCents: 1_000,
    });
    const now = new Date();
    const rotated = await rotateAppKey(ws, app.id, { overlapSec: 3_600, now });
    expect(rotated).not.toBeNull();
    const newKey = rotated!.key;
    expect(newKey).not.toBe(oldKey);
    expect(parseAppKey(newKey)?.id).toBe(app.id);

    // Both secrets authenticate inside the overlap window; only the old one is flagged.
    const inWindow = new Date(now.getTime() + 60_000);
    const viaNew = await verifyAppKey(newKey, inWindow);
    const viaOld = await verifyAppKey(oldKey, inWindow);
    expect(viaNew).toMatchObject({ ok: true, viaPreviousKey: false });
    expect(viaOld).toMatchObject({ ok: true, viaPreviousKey: true });

    // At the deadline the old secret is refused as `rotated`; the new one still works.
    const afterWindow = new Date(now.getTime() + 3_600_000);
    expect(await verifyAppKey(oldKey, afterWindow)).toEqual({ ok: false, reason: 'rotated' });
    expect((await verifyAppKey(newKey, afterWindow)).ok).toBe(true);

    // R-8 still holds across rotation: both digests are stored, neither key nor secret is.
    const [row] = await h.adminSql`
      SELECT row_to_json(c)::text AS json, token_hash, previous_token_hash, rotated_at
        FROM harness_shared.connected_apps c WHERE id = ${app.id}
    `;
    expect(row.token_hash).toBe(sha256(newKey));
    expect(row.previous_token_hash).toBe(sha256(oldKey));
    expect(row.rotated_at).toBeInstanceOf(Date);
    for (const k of [oldKey, newKey]) {
      expect(row.json).not.toContain(k);
      expect(row.json).not.toContain(parseAppKey(k)!.secret);
    }
  });

  it('R-12: rotating again inside the window retires the oldest secret at once', async () => {
    const ws = freshWs();
    const { app, key: first } = await createServiceKey({
      workspaceId: ws,
      userEmail: 'creator@example.test',
      label: 'double-rotate',
      spendCapCents: 1_000,
    });
    const now = new Date();
    const second = (await rotateAppKey(ws, app.id, { overlapSec: 3_600, now }))!.key;
    const third = (await rotateAppKey(ws, app.id, { overlapSec: 3_600, now: new Date(now.getTime() + 1_000) }))!.key;
    const at = new Date(now.getTime() + 2_000);
    expect(await verifyAppKey(first, at)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyAppKey(second, at)).toMatchObject({ ok: true, viaPreviousKey: true });
    expect(await verifyAppKey(third, at)).toMatchObject({ ok: true, viaPreviousKey: false });
  });

  it('a zero overlap is an immediate cutover, and revoke ends an open overlap window', async () => {
    const ws = freshWs();
    const { app, key: oldKey } = await createServiceKey({
      workspaceId: ws,
      userEmail: 'creator@example.test',
      label: 'cutover',
      spendCapCents: 1_000,
    });
    const now = new Date();
    const newKey = (await rotateAppKey(ws, app.id, { overlapSec: 0, now }))!.key;
    expect(await verifyAppKey(oldKey, now)).toEqual({ ok: false, reason: 'rotated' });
    expect((await verifyAppKey(newKey, now)).ok).toBe(true);

    const { app: b, key: bOld } = await createServiceKey({
      workspaceId: ws,
      userEmail: 'creator@example.test',
      label: 'revoked-mid-window',
      spendCapCents: 1_000,
    });
    const bNew = (await rotateAppKey(ws, b.id, { overlapSec: 3_600 }))!.key;
    expect(await revokeAppKey(ws, b.id)).toBe(true);
    expect(await verifyAppKey(bOld)).toEqual({ ok: false, reason: 'revoked' });
    expect(await verifyAppKey(bNew)).toEqual({ ok: false, reason: 'revoked' });
    expect(await rotateAppKey(ws, b.id)).toBeNull();
  });

  it('workspace RLS bounds rotation: another workspace cannot rotate the key', async () => {
    const ws = freshWs();
    const { app, key } = await createServiceKey({
      workspaceId: ws,
      userEmail: 'creator@example.test',
      label: 'rls',
      spendCapCents: 1_000,
    });
    expect(await rotateAppKey(freshWs(), app.id)).toBeNull();
    expect(await verifyAppKey(key)).toMatchObject({ ok: true, viaPreviousKey: false });
  });

  it('R-13 at the storage layer: the database refuses an uncapped service key and malformed rotation state', async () => {
    const ws = freshWs();
    const id = () => `svc${n}${randomBytes(4).toString('hex')}`;
    const digest = sha256(`pcapp_${'S'.repeat(16)}_${'b'.repeat(43)}`);
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps (id, user_email, workspace_id, kind, token_hash)
      VALUES (${id()}, 'o@example.test', ${ws}, 'service', ${digest})
    `).rejects.toThrow(/connected_apps_service_has_spend_cap/);
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps (id, user_email, workspace_id, kind)
      VALUES (${id()}, 'o@example.test', ${ws}, 'service')
    `).rejects.toThrow(/connected_apps_app_has_token_hash|connected_apps_service_has_spend_cap/);
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps (id, user_email, workspace_id, kind, token_hash, spend_cap_cents)
      VALUES (${id()}, 'o@example.test', ${ws}, 'service', ${digest}, 0)
    `).rejects.toThrow(/connected_apps_spend_cap_positive/);
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps
        (id, user_email, workspace_id, kind, token_hash, spend_cap_cents, spend_cap_window_sec)
      VALUES (${id()}, 'o@example.test', ${ws}, 'service', ${digest}, 100, 0)
    `).rejects.toThrow(/connected_apps_spend_cap_window_positive/);
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps
        (id, user_email, workspace_id, kind, token_hash, spend_cap_cents, previous_token_hash)
      VALUES (${id()}, 'o@example.test', ${ws}, 'service', ${digest}, 100, ${digest})
    `).rejects.toThrow(/connected_apps_previous_token_pair/);
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps
        (id, user_email, workspace_id, kind, token_hash, spend_cap_cents,
         previous_token_hash, previous_token_valid_until)
      VALUES (${id()}, 'o@example.test', ${ws}, 'service', ${digest}, 100, 'not-a-digest', now())
    `).rejects.toThrow(/connected_apps_previous_token_hash_shape/);
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps
        (id, user_email, workspace_id, kind, previous_token_hash, previous_token_valid_until)
      VALUES (${id()}, 'o@example.test', ${ws}, 'mobile', ${digest}, now())
    `).rejects.toThrow(/connected_apps_previous_token_kind/);
    // Positive control: a well-formed capped service row is accepted, so the refusals above are
    // the CHECKs firing and not some unrelated insert failure.
    await expect(h.adminSql`
      INSERT INTO harness_shared.connected_apps (id, user_email, workspace_id, kind, token_hash, spend_cap_cents)
      VALUES (${id()}, 'o@example.test', ${ws}, 'service', ${digest}, 100)
    `).resolves.toBeDefined();
  });
});
