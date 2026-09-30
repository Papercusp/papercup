/**
 * kill-switch.integration.test.ts — the per-workspace Remote access switch against REAL Postgres
 * with every migration applied (1263 included) and REAL RLS
 * (external-app-access-to-workspaces-2026-09-29 P-010, R-24/R-41; decision D-025).
 *
 * ./kill-switch.test.ts proves the verdict rules. This file proves the wiring they depend on:
 *   - verifyAppKey reads the switch in the same query as the key, for an app key, a service key
 *     and a client-credentials access token, with no cache — the very next call after
 *     setRemoteAccess(false) is refused, and the next call after setRemoteAccess(true) works;
 *   - the token endpoint's client row (loadClientKeyRow) carries the switch too;
 *   - the switch is per workspace: turning one workspace off leaves another's keys working, and
 *     the write runs RLS-subject, so it can only touch its own workspace's row.
 *
 * Harness shape copied from ./store.integration.test.ts: withWorkspace runs as harness_app
 * (RLS-subject) with the workspace GUC set; getOrgPg().sql is the admin client.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
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

const { createAppKey, createServiceKey, setClientCredentialsMode, verifyAppKey, loadClientKeyRow, appKeyVerdictOf } =
  await import('./store');
const { getRemoteAccess, setRemoteAccess } = await import('./remote-access');
const { PostgresClientCredentialsStore } = await import('./client-credentials');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const freshWs = () => `ks_ws_${randomBytes(3).toString('hex')}`;
const OFF = { ok: false, reason: 'remote_access_off' };

describe('Remote access switch (real PG + real RLS)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('a workspace that never touched the switch is on', async () => {
    const ws = freshWs();
    expect(await getRemoteAccess(ws)).toEqual({ workspaceId: ws, enabled: true, changedAt: null, changedBy: null });
    const { key } = await createAppKey({ workspaceId: ws, userEmail: 'o@example.test', label: 'default-on' });
    expect((await verifyAppKey(key)).ok).toBe(true);
  });

  it('R-24/R-41: off refuses an app key, a service key and an access token on their next call; on restores them', async () => {
    const ws = freshWs();
    const app = await createAppKey({ workspaceId: ws, userEmail: 'o@example.test', label: 'app', tools: ['plans:*'] });
    const svc = await createServiceKey({ workspaceId: ws, userEmail: 'o@example.test', label: 'svc', spendCapCents: 500, tools: ['plans:*'] });
    const client = await createServiceKey({ workspaceId: ws, userEmail: 'o@example.test', label: 'client', spendCapCents: 500, tools: ['plans:*'] });
    const clientRow = await setClientCredentialsMode(ws, client.app.id, { auth: 'client_secret' });
    expect(clientRow?.client_auth).toBe('client_secret');
    const now = new Date();
    const token = await new PostgresClientCredentialsStore().issueToken({
      app: clientRow!,
      scopes: clientRow!.scopes,
      now,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
    });

    // Positive control: all three authenticate while the switch is on.
    for (const bearer of [app.key, svc.key, token]) expect((await verifyAppKey(bearer)).ok).toBe(true);
    expect(appKeyVerdictOf(await loadClientKeyRow(client.app.id), client.key, new Date(), { at: 'token-endpoint' }).ok).toBe(true);

    const off = await setRemoteAccess(ws, false, 'owner@example.test');
    expect(off).toMatchObject({ workspaceId: ws, enabled: false, changedBy: 'owner@example.test' });
    expect(off.changedAt).toBeInstanceOf(Date);

    for (const bearer of [app.key, svc.key, token]) expect(await verifyAppKey(bearer)).toEqual(OFF);
    expect(appKeyVerdictOf(await loadClientKeyRow(client.app.id), client.key, new Date(), { at: 'token-endpoint' })).toEqual(OFF);

    await setRemoteAccess(ws, true, 'owner@example.test');
    for (const bearer of [app.key, svc.key, token]) expect((await verifyAppKey(bearer)).ok).toBe(true);
  });

  it('the switch is per workspace: turning one off leaves another workspace working', async () => {
    const a = freshWs();
    const b = freshWs();
    const keyA = await createAppKey({ workspaceId: a, userEmail: 'o@example.test', label: 'a' });
    const keyB = await createAppKey({ workspaceId: b, userEmail: 'o@example.test', label: 'b' });
    await setRemoteAccess(a, false, 'o@example.test');
    expect(await verifyAppKey(keyA.key)).toEqual(OFF);
    expect((await verifyAppKey(keyB.key)).ok).toBe(true);
    expect((await getRemoteAccess(b)).enabled).toBe(true);
  });

  it("RLS: a workspace transaction cannot read or write another workspace's switch row", async () => {
    const a = freshWs();
    const b = freshWs();
    await setRemoteAccess(a, false, 'o@example.test');
    const seenFromB = await h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${b}, true)`;
      return tx`SELECT workspace_id FROM harness_shared.connected_app_access_settings WHERE workspace_id = ${a}`;
    });
    expect(seenFromB).toHaveLength(0);
    await expect(
      h.appSql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.workspace_id', ${b}, true)`;
        await tx`INSERT INTO harness_shared.connected_app_access_settings (workspace_id, enabled) VALUES (${a}, true)`;
      }),
    ).rejects.toThrow(/row-level security/);
    // Positive control: the admin client does see the row, so the empty read above measured RLS.
    const [row] = await h.adminSql`SELECT enabled FROM harness_shared.connected_app_access_settings WHERE workspace_id = ${a}`;
    expect(row?.enabled).toBe(false);
  });
});
