/**
 * spend-alerts-activity.integration.test.ts — the three P-011 reads against REAL Postgres with every
 * migration applied (1265 included) and REAL RLS
 * (external-app-access-to-workspaces-2026-09-29 P-011, decision D-028).
 *
 * The unit suites (spend-cap.test.ts, alerts.test.ts) inject these reads, so they prove the verdict
 * and alert rules but not the SQL. This file proves the SQL:
 *   - recordAppKeyUse reports the key's first use once, and a network (IPv4 /24) the first time the
 *     key is seen from it — the two facts the new-app (R-28) and new-location (R-42) alerts fire on;
 *   - loadAppSpendStatus sums usage-ledger cost over the worker sessions pinned to THIS app
 *     (`app:<id>` and `app:<id>/<suffix>`), inside the key's window, in the key's workspace only —
 *     the number the spending cap (R-27) is checked against;
 *   - listAppActivity returns this key's calls (its access tokens' included), newest first, and
 *     nothing from another key or another workspace, through the RLS-subject connection.
 *
 * Harness shape copied from ./kill-switch.integration.test.ts: withWorkspace runs as harness_app
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

const { createAppKey, recordAppKeyUse } = await import('./store');
const { loadAppSpendStatus, spendCapVerdict } = await import('./spend');
const { listAppActivity, appActivitySummary } = await import('./activity');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const freshWs = () => `p011_ws_${randomBytes(3).toString('hex')}`;
const HOUR_MS = 3_600_000;

async function newKey(ws: string, label: string) {
  const { app } = await createAppKey({ workspaceId: ws, userEmail: 'o@example.test', label });
  return app.id;
}

/** A worker session launched for an accepted blueprint operation, pinned to `callerId`. */
async function operationSession(ws: string, callerId: string): Promise<string> {
  const sessionId = `p011-sess-${randomBytes(6).toString('hex')}`;
  const launchSpec = { acceptedOperation: { pin: { callerId } } };
  await h.adminSql`
    INSERT INTO harness_shared.adv_sessions (workspace_id, mode, session_id, launch_spec)
    VALUES (${ws}, 'console', ${sessionId}, ${h.adminSql.json(launchSpec)})
  `;
  return sessionId;
}

async function usage(ws: string, sessionId: string, costUsd: number, tsMs: number): Promise<void> {
  await h.adminSql`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source, session_id, cost_usd)
    VALUES (${ws}, ${tsMs}, 'p011-test', 'anthropic', 'test', 'p011-test',
            ${sessionId}, ${costUsd})
  `;
}

async function call(ws: string, caller: string, toolName: string, invokedAt: Date): Promise<void> {
  await h.adminSql`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
       coord_owner_id, invoked_at)
    VALUES (${ws}, 'papercusp', 'p011-test', ${toolName}, 'app', 'p011-spawn', 'p011-window', 'ok',
            ${caller}, ${invokedAt})
  `;
}

describe('P-011 reads (real PG + real RLS)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  describe('recordAppKeyUse: the facts the new-app (R-28) and new-location (R-42) alerts fire on', () => {
    it('reports the first use once, and each network once', async () => {
      const ws = freshWs();
      const id = await newKey(ws, 'use-facts');

      expect(await recordAppKeyUse(id, '203.0.113.7')).toEqual({ firstUse: true, newNetwork: '203.0.113.0/24' });
      // A different network: not a first use, but a new location.
      expect(await recordAppKeyUse(id, '198.51.100.20')).toEqual({ firstUse: false, newNetwork: '198.51.100.0/24' });
      // Back to a known network from another address in it: neither.
      expect(await recordAppKeyUse(id, '203.0.113.99')).toEqual({ firstUse: false, newNetwork: null });

      const nets = await h.adminSql`
        SELECT network, workspace_id FROM harness_shared.connected_app_networks WHERE app_id = ${id} ORDER BY network
      `;
      expect(nets.map((r: any) => [r.network, r.workspace_id])).toEqual([
        ['198.51.100.0/24', ws],
        ['203.0.113.0/24', ws],
      ]);
      const [row] = await h.adminSql`SELECT first_used_at FROM harness_shared.connected_apps WHERE id = ${id}`;
      expect(row.first_used_at).toBeInstanceOf(Date);
    });

    it('a first use with no reported address is still a first use, with no network', async () => {
      const ws = freshWs();
      const id = await newKey(ws, 'no-address');
      expect(await recordAppKeyUse(id, null)).toEqual({ firstUse: true, newNetwork: null });
    });

    it('a repeat call from the same address inside the throttle window reports nothing new', async () => {
      const ws = freshWs();
      const id = await newKey(ws, 'throttled');
      await recordAppKeyUse(id, '203.0.113.7');
      expect(await recordAppKeyUse(id, '203.0.113.7')).toEqual({ firstUse: false, newNetwork: null });
    });
  });

  describe('loadAppSpendStatus: the spend the cap (R-27) is checked against', () => {
    it('sums only this app’s operation sessions, in its workspace, inside its window', async () => {
      const ws = freshWs();
      const id = await newKey(ws, 'spender');
      const other = await newKey(ws, 'someone-else');
      await h.adminSql`
        UPDATE harness_shared.connected_apps SET spend_cap_cents = 200, spend_cap_window_sec = 3600 WHERE id = ${id}
      `;
      const now = new Date();
      const t = now.getTime();

      const direct = await operationSession(ws, `app:${id}`);
      const viaToken = await operationSession(ws, `app:${id}/tok_1`);
      const otherApp = await operationSession(ws, `app:${other}`);
      const otherWs = await operationSession(freshWs(), `app:${id}`);

      await usage(ws, direct, 1.0, t - 60_000); // counted
      await usage(ws, viaToken, 0.5, t - 120_000); // counted: an access token of this key
      await usage(ws, direct, 5.0, t - 2 * HOUR_MS); // outside the 1h window
      await usage(ws, otherApp, 9.0, t - 60_000); // another key
      // Another workspace's session pinned to the same caller string (a sample in the same
      // workspace as its session, as the ledger records it).
      const [{ workspace_id: foreignWs }] = await h.adminSql`
        SELECT workspace_id FROM harness_shared.adv_sessions WHERE session_id = ${otherWs}
      `;
      await usage(foreignWs, otherWs, 9.0, t - 60_000);

      const status = await loadAppSpendStatus(id, now);
      expect(status).toEqual({ capCents: 200, spentCents: 150, windowSec: 3600 });
      expect(spendCapVerdict(status!)).toMatchObject({ state: 'under', spentCents: 150, capCents: 200 });

      // Lifetime window (null) counts the older sample too, and 650 >= 200 reaches the cap.
      await h.adminSql`UPDATE harness_shared.connected_apps SET spend_cap_window_sec = NULL WHERE id = ${id}`;
      const lifetime = await loadAppSpendStatus(id, now);
      expect(lifetime).toEqual({ capCents: 200, spentCents: 650, windowSec: null });
      expect(spendCapVerdict(lifetime!).state).toBe('reached');
    });

    it('a key with no recorded work has spent nothing; an unknown key has no status', async () => {
      const ws = freshWs();
      const id = await newKey(ws, 'idle');
      expect(await loadAppSpendStatus(id)).toMatchObject({ spentCents: 0 });
      expect(await loadAppSpendStatus(`zz${randomBytes(7).toString('hex')}`)).toBeNull();
    });
  });

  describe('listAppActivity: one key’s calls, through the RLS-subject connection', () => {
    it('returns this key’s calls and its tokens’, newest first, and nothing else', async () => {
      const ws = freshWs();
      const id = await newKey(ws, 'active');
      const other = await newKey(ws, 'quiet');
      const t0 = Date.now() - 10 * 60_000;
      await call(ws, `app:${id}`, 'blueprint:submit', new Date(t0));
      await call(ws, `app:${id}/tok_1`, 'blueprint:status', new Date(t0 + 60_000));
      await call(ws, `app:${id}`, 'blueprint:result', new Date(t0 + 120_000));
      await call(ws, `app:${other}`, 'blueprint:submit', new Date(t0 + 30_000));
      await call(ws, 'su-someone', 'plans:list', new Date(t0 + 90_000));
      await call(freshWs(), `app:${id}`, 'blueprint:submit', new Date(t0 + 150_000));

      const all = await listAppActivity(ws, id);
      expect(all.map((e) => [e.toolName, e.caller])).toEqual([
        ['blueprint:result', `app:${id}`],
        ['blueprint:status', `app:${id}/tok_1`],
        ['blueprint:submit', `app:${id}`],
      ]);

      expect((await listAppActivity(ws, id, { limit: 2 })).map((e) => e.toolName))
        .toEqual(['blueprint:result', 'blueprint:status']);
      expect((await listAppActivity(ws, id, { before: new Date(t0 + 60_000) })).map((e) => e.toolName))
        .toEqual(['blueprint:submit']);
    });

    it('appActivitySummary pairs the spend verdict with the recent calls', async () => {
      const ws = freshWs();
      const id = await newKey(ws, 'summary');
      await call(ws, `app:${id}`, 'blueprint:submit', new Date());
      const summary = await appActivitySummary(ws, id);
      expect(summary?.appId).toBe(id);
      expect(summary?.recent.map((e) => e.toolName)).toEqual(['blueprint:submit']);
      expect(summary?.spend).toMatchObject({ spentCents: 0 });
    });
  });
});
