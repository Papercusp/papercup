/**
 * alert-sweep.integration.test.ts — the P-328 sweep's SQL against REAL Postgres with every migration
 * applied (1267 included) (external-app-access-to-workspaces-2026-09-29 P-328, decision D-030).
 *
 * The unit suite (alert-sweep.test.ts) proves the alert rules on hand-built keys. This file proves
 * the numbers those rules read:
 *   - verifyAppKey counts each refused use of a KNOWN key (wrong secret) into one row per key per
 *     hour, and counts nothing for a key it cannot attribute (unknown id, malformed bearer);
 *   - loadSweepKeys reports a key's calls in the last hour and in the prior 7 days from
 *     tool_invocations, its auth failures, and whether its creator has left every organization;
 *   - revoked keys are not swept;
 *   - runConnectedAppAlertSweep over those rows raises the four sweep alerts.
 *
 * Harness shape copied from ./spend-alerts-activity.integration.test.ts: getOrgPg().sql is the
 * admin client of a fresh migrated database.
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

const { createAppKey, revokeAppKey, verifyAppKey } = await import('./store');
const { AUTH_FAILURE_ALERT_THRESHOLD, loadSweepKeys, runConnectedAppAlertSweep } = await import('./alert-sweep');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const freshWs = () => `p328_ws_${randomBytes(3).toString('hex')}`;
const DAY_MS = 86_400_000;

/** The same key id with a different secret: well-formed, attributable, refused as a mismatch. */
function wrongSecret(key: string): string {
  const last = key.charAt(key.length - 1);
  return key.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

/** `count` tool calls by `caller`, spread over the `ageMinutes` window ending `endAgoMinutes` ago. */
async function calls(ws: string, caller: string, count: number, endAgoMinutes: number, spanMinutes: number): Promise<void> {
  await h.adminSql`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
       coord_owner_id, invoked_at)
    SELECT ${ws}, 'papercusp', 'p328-test', 'harness:list', 'app', 'p328-spawn', 'p328-window', 'ok',
           ${caller},
           now() - make_interval(mins => ${endAgoMinutes}) - (g * make_interval(secs => ${Math.floor((spanMinutes * 60) / Math.max(count, 1))}))
      FROM generate_series(0, ${count - 1}) AS g
  `;
}

/** One hosted user with one membership per entry of `statuses`, each in a fresh organization. */
async function member(email: string, ...statuses: Array<'active' | 'revoked'>): Promise<void> {
  const [user] = await h.adminSql`
    INSERT INTO papercusp_auth.hosted_users (primary_email) VALUES (${email}) RETURNING id
  `;
  for (const status of statuses) {
    const [org] = await h.adminSql`
      INSERT INTO papercusp_auth.organizations (external_organization_id, display_name)
      VALUES (${`p328-org-${randomBytes(4).toString('hex')}`}, 'P-328 test org')
      RETURNING id
    `;
    await h.adminSql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, status, created_via, revoked_at)
      VALUES (${org.id}, ${user.id}, 'member', ${status}, 'member_management',
              ${status === 'revoked' ? new Date() : null})
    `;
  }
}

describe('P-328 sweep reads (real PG, migration 1267)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const sweptIn = async (ws: string) => (await loadSweepKeys()).filter((k) => k.workspace_id === ws);

  it('counts refused uses of a known key per hour, and nothing for an unattributable bearer', async () => {
    const ws = freshWs();
    const { app, key } = await createAppKey({ workspaceId: ws, userEmail: 'maker@example.test', label: 'Zapier' });
    for (let i = 0; i < AUTH_FAILURE_ALERT_THRESHOLD; i += 1) {
      expect(await verifyAppKey(wrongSecret(key))).toMatchObject({ ok: false, reason: 'mismatch' });
    }
    expect((await verifyAppKey('pcapp_not-a-key')).ok).toBe(false);
    expect((await verifyAppKey(key)).ok).toBe(true);

    // The count is fire-and-forget on the auth path, so wait for it to land.
    await vi.waitFor(async () => {
      const [row] = await sweptIn(ws);
      expect(row.auth_failures).toBe(AUTH_FAILURE_ALERT_THRESHOLD);
    });
    const rows = await h.adminSql`
      SELECT failures, last_reason FROM harness_shared.connected_app_auth_failures WHERE app_id = ${app.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ failures: AUTH_FAILURE_ALERT_THRESHOLD, last_reason: 'mismatch' });
    const [swept] = await sweptIn(ws);
    expect(swept.last_failure_reason).toBe('mismatch');
    // Nothing of the presented bearer is stored.
    expect(JSON.stringify(rows)).not.toContain(wrongSecret(key));
  });

  it("reads each key's last-hour and prior-7-day calls, only its own and only in its workspace", async () => {
    const ws = freshWs();
    const other = freshWs();
    const { app: a } = await createAppKey({ workspaceId: ws, userEmail: 'maker@example.test', label: 'Spiky' });
    const { app: b } = await createAppKey({ workspaceId: ws, userEmail: 'maker@example.test', label: 'Quiet' });
    await calls(ws, `app:${a.id}`, 250, 1, 50);          // last hour
    await calls(ws, `app:${a.id}/sub-1`, 5, 1, 30);      // a suffixed caller is the same key
    await calls(ws, `app:${a.id}`, 7, 3 * 60, 3 * DAY_MS / 60_000); // prior 7 days
    await calls(ws, `app:${a.id}`, 4, 9 * 24 * 60, 60);  // older than the window
    await calls(ws, `app:${b.id}`, 3, 1, 30);
    await calls(other, `app:${a.id}`, 40, 1, 30);        // same caller string, another workspace

    const swept = new Map((await sweptIn(ws)).map((k) => [k.id, k]));
    expect(swept.get(a.id)).toMatchObject({ calls_last_hour: 255, calls_prior_7d: 7, auth_failures: 0 });
    expect(swept.get(b.id)).toMatchObject({ calls_last_hour: 3, calls_prior_7d: 0 });
  });

  it("flags a key whose creator has left every organization, and not one who is still a member", async () => {
    const ws = freshWs();
    const tag = randomBytes(3).toString('hex');
    const gone = `Gone-${tag}@Example.test`;
    const stays = `stays-${tag}@example.test`;
    const never = `never-${tag}@example.test`;
    await member(gone.toLowerCase(), 'revoked', 'revoked');
    await member(stays, 'revoked', 'active');
    const { app: g } = await createAppKey({ workspaceId: ws, userEmail: gone, label: 'Left' });
    const { app: s } = await createAppKey({ workspaceId: ws, userEmail: stays, label: 'Stayed' });
    const { app: n } = await createAppKey({ workspaceId: ws, userEmail: never, label: 'No org' });

    const swept = new Map((await sweptIn(ws)).map((k) => [k.id, k]));
    expect(swept.get(g.id)?.creator_removed).toBe(true);
    expect(swept.get(s.id)?.creator_removed).toBe(false);
    expect(swept.get(n.id)?.creator_removed).toBe(false);
  });

  it('does not sweep a revoked key', async () => {
    const ws = freshWs();
    const { app } = await createAppKey({ workspaceId: ws, userEmail: 'maker@example.test', label: 'Revoked' });
    expect(await revokeAppKey(ws, app.id)).toBe(true);
    expect(await sweptIn(ws)).toEqual([]);
  });

  it('raises the four sweep alerts from these rows', async () => {
    const ws = freshWs();
    const creator = `left-${randomBytes(3).toString('hex')}@example.test`;
    await member(creator, 'revoked');
    const { app, key } = await createAppKey({
      workspaceId: ws,
      userEmail: creator,
      label: 'Everything',
      expiresAt: new Date(Date.now() + 3 * DAY_MS),
    });
    await calls(ws, `app:${app.id}`, 300, 1, 50);
    for (let i = 0; i < AUTH_FAILURE_ALERT_THRESHOLD; i += 1) await verifyAppKey(wrongSecret(key));
    await vi.waitFor(async () => expect((await sweptIn(ws))[0]?.auth_failures).toBe(AUTH_FAILURE_ALERT_THRESHOLD));

    const notified: Array<{ dedupeKey: string; workspaceId: string }> = [];
    const result = await runConnectedAppAlertSweep({
      load: () => sweptIn(ws),
      notify: async (input) => { notified.push({ dedupeKey: input.dedupeKey, workspaceId: String(input.workspaceId) }); },
    });
    expect(result.failed).toBe(0);
    expect(result.alerts.map((alert) => alert.kind).sort()).toEqual(['auth-failures', 'creator-removed', 'key-expiring', 'usage-spike']);
    expect(notified.every((n) => n.workspaceId === ws)).toBe(true);
    expect(new Set(notified.map((n) => n.dedupeKey)).size).toBe(4);
  });
});
