/**
 * device-grants.integration.test.ts — the local device-code sign-in store against REAL Postgres
 * with every migration applied (1248 included) and REAL RLS
 * (external-app-access-to-workspaces-2026-09-29 P-005).
 *
 * Harness copied from ./store.integration.test.ts: withWorkspace runs as harness_app (RLS-subject)
 * with the workspace GUC set; getOrgPg().sql is the admin client.
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

const { PostgresDeviceGrantStore } = await import('./device-grants');
const { verifyAppKey } = await import('./store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
let n = 0;
const fresh = () => {
  n += 1;
  const tag = randomBytes(2).toString('hex').toUpperCase().replace(/[^A-Z0-9]/g, 'B');
  return {
    ws: `grant_ws_${n}_${tag}`,
    codeHash: sha256(`pad_${n}_${randomBytes(8).toString('hex')}`),
    userCode: `${tag.padEnd(4, 'C').slice(0, 4)}-${String(1000 + n).slice(-4)}`,
  };
};

describe('connected-app device grants (real PG + real RLS)', () => {
  let db: OrgTestDb;
  const store = new PostgresDeviceGrantStore();
  const t0 = new Date();
  const later = new Date(t0.getTime() + 10 * 60_000);

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function approvedGrant(scopes: object = { capabilities: [], tools: ['plans:*'] }) {
    const f = fresh();
    expect(await store.createGrant({
      deviceCodeHash: f.codeHash, userCode: f.userCode, clientLabel: 'ci-bot',
      requestedScopes: scopes as never, createdAt: t0, expiresAt: later,
    })).toBe(true);
    expect(await store.decideGrant({ userCode: f.userCode, decision: 'approved', workspaceId: f.ws, decidedBy: 'local@desktop', at: t0 })).toBe(true);
    return f;
  }

  it('R-9: an approved grant becomes a verifiable key with the requested scopes, in the approved workspace', async () => {
    const f = await approvedGrant({ capabilities: [], tools: ['plans:*'], harnesses: ['papercusp'] });
    const result = await store.exchangeGrant({ deviceCodeHash: f.codeHash, now: t0, minPollIntervalMs: 4_000 });
    expect(result.status).toBe('issued');
    if (result.status !== 'issued') return;
    const verdict = await verifyAppKey(result.issued.key);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.app).toMatchObject({ workspace_id: f.ws, label: 'ci-bot', user_email: 'local@desktop' });
    expect(verdict.app.scopes).toEqual({ capabilities: [], tools: ['plans:*'], harnesses: ['papercusp'] });
    const [grant] = await db.adminSql`SELECT state, app_id FROM harness_shared.connected_app_device_grants WHERE device_code_hash = ${f.codeHash}`;
    expect(grant).toEqual({ state: 'consumed', app_id: verdict.app.id });
  });

  it('two concurrent polls on one approved grant produce exactly one key', async () => {
    const f = await approvedGrant();
    const results = await Promise.all([
      store.exchangeGrant({ deviceCodeHash: f.codeHash, now: t0, minPollIntervalMs: 4_000 }),
      store.exchangeGrant({ deviceCodeHash: f.codeHash, now: t0, minPollIntervalMs: 4_000 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['invalid', 'issued']);
    const keys = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.connected_apps WHERE workspace_id = ${f.ws} AND kind = 'app'`;
    expect(keys[0].n).toBe(1);
  });

  it('a pending grant answers pending, then slow_down when polled too fast', async () => {
    const f = fresh();
    await store.createGrant({ deviceCodeHash: f.codeHash, userCode: f.userCode, clientLabel: 'x', requestedScopes: {}, createdAt: t0, expiresAt: later });
    expect((await store.exchangeGrant({ deviceCodeHash: f.codeHash, now: t0, minPollIntervalMs: 4_000 })).status).toBe('pending');
    expect((await store.exchangeGrant({ deviceCodeHash: f.codeHash, now: new Date(t0.getTime() + 1_000), minPollIntervalMs: 4_000 })).status).toBe('slow_down');
    expect((await store.exchangeGrant({ deviceCodeHash: f.codeHash, now: new Date(t0.getTime() + 5_000), minPollIntervalMs: 4_000 })).status).toBe('pending');
    expect((await store.exchangeGrant({ deviceCodeHash: f.codeHash, now: later, minPollIntervalMs: 4_000 })).status).toBe('expired');
  });

  it('refuses to approve without a workspace, and a hard-denied scope never becomes a key', async () => {
    const f = fresh();
    await store.createGrant({ deviceCodeHash: f.codeHash, userCode: f.userCode, clientLabel: 'x', requestedScopes: {}, createdAt: t0, expiresAt: later });
    expect(await store.decideGrant({ userCode: f.userCode, decision: 'approved', workspaceId: null, decidedBy: 'local@desktop', at: t0 })).toBe(false);
    // A grant whose stored scopes were forged to a hard-denied group is refused at issue time.
    const g = await approvedGrant({ capabilities: [], tools: ['capability:*'] });
    const res = await store.exchangeGrant({ deviceCodeHash: g.codeHash, now: t0, minPollIntervalMs: 4_000 });
    expect(res.status).toBe('invalid_scope');
  });

  it('stores only the hash of the device code, and RLS hides a pending grant from the workspace role', async () => {
    const f = await approvedGrant();
    const [row] = await db.adminSql`SELECT row_to_json(g)::text AS j FROM harness_shared.connected_app_device_grants g WHERE device_code_hash = ${f.codeHash}`;
    expect(row.j).not.toMatch(/pad_/);
    const p = fresh();
    await store.createGrant({ deviceCodeHash: p.codeHash, userCode: p.userCode, clientLabel: 'x', requestedScopes: {}, createdAt: t0, expiresAt: later });
    const visible = await db.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${f.ws}, true)`;
      return tx`SELECT device_code_hash FROM harness_shared.connected_app_device_grants`;
    });
    expect(visible.map((r: { device_code_hash: string }) => r.device_code_hash)).toEqual([f.codeHash]);
  });
});
