/**
 * The portal side of relay linking (external-app-access P-008, D-031, migration 1268) against real
 * Postgres and the production privilege path.
 *
 * index.test.ts injects the store, so it cannot fail if the database refuses the writes. This file
 * runs PostgresHostedCliStore exactly as hosted-runtime.ts wires it: grants and tokens through
 * `harness_app` + `SET LOCAL ROLE hosted_service`, and the organization's customer workspaces through
 * `harness_app` with `app.workspace_id` set (RLS-subject). It proves that:
 *   - a relay-link grant carries its install id, can never be exchanged for a CLI token, and is
 *     consumed exactly once by the relay-link exchange;
 *   - the table refuses a relay-link grant with no install id;
 *   - a linked customer workspace needs no workspace_hosts row, while a hosted row still does;
 *   - linked rows are not counted by the one-live-workspace-per-organization rule (D-397) and are
 *     not listed as terminal workspaces;
 *   - unlinking marks the row deleted, and re-linking the same install revives the same row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import { createOrgTestDb } from '../../../../test/_org-test-db';
import { linkedWorkspaceIdentity, PostgresHostedCliStore } from './store';

const CONTROL_PLANE = 'hosted-control-plane-p008';
const ORG = 'org_relay_link_it';

let db: OrgTestDb;

/** Production's hosted-service transaction shape: harness_app, then SET LOCAL ROLE. */
const runService = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;

/** Production's control-plane read: withWorkspace(controlPlaneWorkspaceId) on the RLS-subject role. */
const runControlPlane = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${CONTROL_PLANE}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;

const store = () => new PostgresHostedCliStore(runService, runControlPlane, CONTROL_PLANE);

function deviceCode(): { code: string; hash: string } {
  const code = randomBytes(16).toString('hex');
  return { code, hash: createHash('sha256').update(code).digest('hex') };
}

function userCode(): string {
  const a = () => randomBytes(4).toString('hex').toUpperCase().slice(0, 4);
  return `${a()}-${a()}`;
}

const token = () => ({ id: `tok_${randomBytes(6).toString('hex')}`, tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 3_600_000) });

describe('hosted-cli store: relay linking (real PG, migration 1268)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('a relay-link grant carries its install id, never becomes a CLI token, and is consumed once', async () => {
    const s = store();
    const dc = deviceCode();
    const uc = userCode();
    const now = new Date();
    expect(
      await s.createGrant({
        deviceCodeHash: dc.hash,
        userCode: uc,
        clientLabel: 'Avi laptop',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        purpose: 'relay-link',
        installId: 'install-5b1c9e0d',
      }),
    ).toBe(true);

    expect(await s.findPendingGrant(uc, now)).toMatchObject({ purpose: 'relay-link', installId: 'install-5b1c9e0d' });
    const poll = { deviceCodeHash: dc.hash, now: new Date(now.getTime() + 10_000), minPollIntervalMs: 5_000 };
    expect(await s.exchangeRelayLinkGrant(poll)).toEqual({ status: 'pending' });

    expect(await s.decideGrant({ userCode: uc, decision: 'approved', userId: 'user_1', organizationId: ORG, at: new Date(now.getTime() + 20_000) })).toBe(true);
    // The psu exchange does not see a relay-link grant at all: no CLI token can come of it.
    expect(await s.exchangeGrant({ ...poll, now: new Date(now.getTime() + 30_000), token: token() })).toEqual({ status: 'invalid' });
    const [{ n }] = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM papercusp_auth.hosted_cli_tokens WHERE control_workspace_id = ${CONTROL_PLANE}`;
    expect(n).toBe(0);

    expect(await s.exchangeRelayLinkGrant({ ...poll, now: new Date(now.getTime() + 40_000) })).toEqual({
      status: 'approved',
      userId: 'user_1',
      organizationId: ORG,
      installId: 'install-5b1c9e0d',
      clientLabel: 'Avi laptop',
    });
    expect(await s.exchangeRelayLinkGrant({ ...poll, now: new Date(now.getTime() + 50_000) })).toEqual({ status: 'invalid' });
  });

  it('the relay-link exchange does not see a psu grant', async () => {
    const s = store();
    const dc = deviceCode();
    const now = new Date();
    await s.createGrant({ deviceCodeHash: dc.hash, userCode: userCode(), clientLabel: 'psu', createdAt: now, expiresAt: new Date(now.getTime() + 600_000), installId: 'install-ignored' });
    expect(await s.exchangeRelayLinkGrant({ deviceCodeHash: dc.hash, now, minPollIntervalMs: 5_000 })).toEqual({ status: 'invalid' });
    // A psu grant never records an install id, even when one is passed.
    const [row] = await db.adminSql<{ purpose: string; install_id: string | null }[]>`
      SELECT purpose, install_id FROM papercusp_auth.hosted_cli_device_grants WHERE device_code_hash = ${dc.hash}`;
    expect(row).toEqual({ purpose: 'cli', install_id: null });
  });

  it('the table refuses a relay-link grant with no install id', async () => {
    const now = new Date();
    await expect(
      store().createGrant({ deviceCodeHash: deviceCode().hash, userCode: userCode(), clientLabel: 'x', createdAt: now, expiresAt: new Date(now.getTime() + 600_000), purpose: 'relay-link' }),
    ).rejects.toThrow(/hosted_cli_device_grants_purpose_ck/);
  });

  it('a linked workspace needs no workspace_hosts row; a hosted row still does', async () => {
    const s = store();
    const at = new Date();
    const first = await s.upsertLinkedWorkspace({ organizationId: ORG, installId: 'install-aaaa1111', displayName: 'Laptop', userId: 'user_1', at });
    expect(first).toEqual(linkedWorkspaceIdentity(ORG, 'install-aaaa1111'));
    expect(first.hostId).toBe(`linked-${first.customerWorkspaceId}`);
    const [row] = await db.adminSql<{ kind: string; linked_install_id: string; hosted_host_id: string | null; state: string }[]>`
      SELECT kind, linked_install_id, hosted_host_id, state FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${CONTROL_PLANE} AND id = ${first.customerWorkspaceId}`;
    expect(row).toEqual({ kind: 'linked', linked_install_id: 'install-aaaa1111', hosted_host_id: null, state: 'active' });

    await expect(db.adminSql`
      INSERT INTO harness_shared.customer_workspaces
        (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id)
      VALUES (${CONTROL_PLANE}, 'ws-hosted-no-host', ${ORG}, 'host-that-does-not-exist', 'Hosted', 'active', 'user', 'user_1')`).rejects.toThrow(
      /customer_workspaces_host_fk/,
    );
    // A linked row must name its install; a hosted row must not.
    await expect(db.adminSql`
      INSERT INTO harness_shared.customer_workspaces
        (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id, kind)
      VALUES (${CONTROL_PLANE}, 'lw-no-install', ${ORG}, 'linked-lw-no-install', 'Linked', 'active', 'user', 'user_1', 'linked')`).rejects.toThrow(
      /customer_workspaces_linked_install_ck/,
    );
  });

  it('linked rows are not counted by the one-live-workspace rule and are not listed as terminals', async () => {
    const s = store();
    const at = new Date();
    const org = `${ORG}_two`;
    const a = await s.upsertLinkedWorkspace({ organizationId: org, installId: 'install-bbbb2222', displayName: 'A', userId: 'user_1', at });
    const b = await s.upsertLinkedWorkspace({ organizationId: org, installId: 'install-cccc3333', displayName: 'B', userId: 'user_1', at });
    expect(a.customerWorkspaceId).not.toBe(b.customerWorkspaceId);
    const [{ n }] = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${CONTROL_PLANE} AND organization_id = ${org} AND state <> 'deleted'`;
    expect(n).toBe(2);
    expect(await s.listWorkspaces(org)).toEqual([]);
  });

  it('unlinking marks the row deleted; re-linking the same install revives the same row', async () => {
    const s = store();
    const at = new Date();
    const org = `${ORG}_three`;
    const linked = await s.upsertLinkedWorkspace({ organizationId: org, installId: 'install-dddd4444', displayName: 'Desk', userId: 'user_1', at });

    expect(await s.unlinkLinkedWorkspace({ organizationId: org, customerWorkspaceId: linked.customerWorkspaceId, at })).toBe(true);
    // Idempotent, and scoped to the organization.
    expect(await s.unlinkLinkedWorkspace({ organizationId: org, customerWorkspaceId: linked.customerWorkspaceId, at })).toBe(true);
    expect(await s.unlinkLinkedWorkspace({ organizationId: 'org_other', customerWorkspaceId: linked.customerWorkspaceId, at })).toBe(false);
    let [row] = await db.adminSql<{ state: string; deleted_at: Date | null }[]>`
      SELECT state, deleted_at FROM harness_shared.customer_workspaces WHERE workspace_id = ${CONTROL_PLANE} AND id = ${linked.customerWorkspaceId}`;
    expect(row!.state).toBe('deleted');
    expect(row!.deleted_at).toBeInstanceOf(Date);

    const again = await s.upsertLinkedWorkspace({ organizationId: org, installId: 'install-dddd4444', displayName: 'Desk 2', userId: 'user_1', at: new Date() });
    expect(again).toEqual(linked);
    [row] = await db.adminSql<{ state: string; deleted_at: Date | null }[]>`
      SELECT state, deleted_at FROM harness_shared.customer_workspaces WHERE workspace_id = ${CONTROL_PLANE} AND id = ${linked.customerWorkspaceId}`;
    expect(row).toEqual({ state: 'active', deleted_at: null });
  });
});
