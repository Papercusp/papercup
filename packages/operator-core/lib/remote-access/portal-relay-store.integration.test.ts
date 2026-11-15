/**
 * portal-relay-store.integration.test.ts — this install's Papercusp-relay row (external-app-access
 * P-008, D-031 #6, migration 1268) against REAL Postgres with every migration applied.
 *
 * Covers what the unit tests (relay-opt-in.test.ts, which injects the store) cannot: the table
 * refuses to link before the user agreed to the notice (R-20 at the database, not only in the
 * code path), the device code and the connector bearer are stored as pgcrypto ciphertext and
 * decrypt only with the right key, turning the relay off drops the link and both secrets but
 * keeps the consent, and the portal can be changed only while the relay is off.
 *
 * The store takes `sql` and `encryptionKey` as options, so this test passes the admin client of
 * a throwaway migrated database directly; nothing is mocked. Shaped like own-tunnel/store's test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync, existsSync } from 'node:fs';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import {
  ensurePortalRelayRow,
  readPortalRelay,
  readPortalRelaySecrets,
  recordPortalRelayConsent,
  recordPortalRelayError,
  savePortalRelayLinked,
  savePortalRelayLinking,
  setPortalRelayOff,
  setPortalRelayOperatorPort,
  withPortalRelayLinkLock,
  savePortalRelayDesktopGrant,
  clearPortalRelayDesktopGrant,
  currentPortalRelayDesktopGrant,
  type PortalRelayDesktopGrant,
} from './portal-relay-store';
import { beginPortalRelayLink, defaultPortalRelayDeps, PORTAL_RELAY_NOTICE_VERSION } from './relay-opt-in';

const KEY = 'portal-relay-integration-test-key';
const DEVICE_CODE = 'relay-device-code-PLAINTEXT-5d2e';
const BEARER = 'relay-connector-bearer-PLAINTEXT-a81f';
const INSTALL = 'install-3f9a2c7e';
const PORTAL = 'https://portal.example.test';

const linking = {
  userCode: 'WXYZ-1234',
  verificationUri: `${PORTAL}/device`,
  deviceCode: DEVICE_CODE,
  grantExpiresAt: new Date(Date.now() + 15 * 60_000),
  pollIntervalSec: 5,
};

const linked = {
  userId: 'portal-user-1',
  organizationId: 'org_1',
  customerWorkspaceId: 'lw-0123456789abcdef01234567',
  appBaseUrl: `${PORTAL}/api/workspaces/lw-0123456789abcdef01234567`,
  connectorUrl: `${PORTAL}/api/hosted/connector`,
  connectorBearer: BEARER,
  operatorPort: 3070,
};

describe('portal relay store (real PG, migration 1268)', () => {
  let db: OrgTestDb;
  const opts = () => ({ sql: db.adminSql, encryptionKey: KEY });

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Exercise the additive candidate before arming it for live installations.
    const migration = new URL('../../../../libs/papercusp/libs/db/sql/1635-portal-relay-desktop-grants.sql', import.meta.url);
    const source = readFileSync(existsSync(migration) ? migration : new URL(`${migration.href}.DRAFT`), 'utf8');
    await db.adminSql.unsafe(source.replace(/^\\.*$/gm, ''));
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.adminSql`DELETE FROM harness_shared.remote_access_portal_relay`;
  });

  it('consent is a no-op until the row exists, then records the notice version', async () => {
    expect(await recordPortalRelayConsent({ noticeVersion: 1, by: 'owner' }, opts())).toBe(false);
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    expect(await readPortalRelay(opts())).toMatchObject({ state: 'off', consentNoticeVersion: null, consentedAt: null });
    expect(await recordPortalRelayConsent({ noticeVersion: 1, by: 'owner' }, opts())).toBe(true);
    const row = await readPortalRelay(opts());
    expect(row).toMatchObject({ installId: INSTALL, portalOrigin: PORTAL, consentNoticeVersion: 1, consentedBy: 'owner' });
    expect(row?.consentedAt).toBeInstanceOf(Date);
  });

  it('the table refuses to start linking before the notice is agreed to (R-20)', async () => {
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    await expect(savePortalRelayLinking(linking, opts())).rejects.toThrow(/remote_access_portal_relay_linking_complete/);
    expect((await readPortalRelay(opts()))?.state).toBe('off');
  });

  it('stores the device code and the connector bearer as ciphertext, readable only with the right key', async () => {
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    await recordPortalRelayConsent({ noticeVersion: 1, by: null }, opts());
    await savePortalRelayLinking(linking, opts());

    let raw = await db.adminSql<{ row: string }[]>`SELECT row_to_json(t)::text AS row FROM harness_shared.remote_access_portal_relay t`;
    expect(raw[0]!.row).not.toContain(DEVICE_CODE);
    expect(await readPortalRelaySecrets(opts())).toEqual({ deviceCode: DEVICE_CODE, connectorBearer: null });
    expect(await readPortalRelay(opts())).toMatchObject({ state: 'linking', userCode: 'WXYZ-1234', pollIntervalSec: 5 });

    await savePortalRelayLinked(linked, opts());
    raw = await db.adminSql<{ row: string }[]>`SELECT row_to_json(t)::text AS row FROM harness_shared.remote_access_portal_relay t`;
    expect(raw[0]!.row).not.toContain(BEARER);
    // Linking spends the pending grant: its code and device code are gone.
    expect(await readPortalRelaySecrets(opts())).toEqual({ deviceCode: null, connectorBearer: BEARER });
    await expect(readPortalRelaySecrets({ sql: db.adminSql, encryptionKey: 'wrong-key' })).rejects.toThrow();
    expect(await readPortalRelay(opts())).toMatchObject({
      state: 'linked',
      userCode: null,
      verificationUri: null,
      organizationId: 'org_1',
      customerWorkspaceId: linked.customerWorkspaceId,
      appBaseUrl: linked.appBaseUrl,
      operatorPort: 3070,
    });
  });

  it('the table refuses a linked row missing its link, and a malformed install id', async () => {
    await expect(db.adminSql`
      INSERT INTO harness_shared.remote_access_portal_relay (install_id, portal_origin, state, consent_notice_version, consented_at)
      VALUES (${INSTALL}, ${PORTAL}, 'linked', 1, now())`).rejects.toThrow(/remote_access_portal_relay_linked_complete/);
    await expect(ensurePortalRelayRow({ installId: 'Bad Id', portalOrigin: PORTAL }, opts())).rejects.toThrow(
      /remote_access_portal_relay_install_id_check/,
    );
    await expect(ensurePortalRelayRow({ installId: INSTALL, portalOrigin: `${PORTAL}/path` }, opts())).rejects.toThrow(
      /remote_access_portal_relay_portal_origin_check/,
    );
  });

  it('turning off drops the link and both secrets but keeps the consent', async () => {
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    await recordPortalRelayConsent({ noticeVersion: 1, by: 'owner' }, opts());
    await savePortalRelayLinking(linking, opts());
    await savePortalRelayLinked(linked, opts());

    await setPortalRelayOff('revoked on the portal', opts());
    const row = await readPortalRelay(opts());
    expect(row).toMatchObject({
      state: 'off',
      consentNoticeVersion: 1,
      organizationId: null,
      customerWorkspaceId: null,
      appBaseUrl: null,
      connectorUrl: null,
      linkedAt: null,
      lastError: 'revoked on the portal',
    });
    expect(row?.lastErrorAt).toBeInstanceOf(Date);
    expect(await readPortalRelaySecrets(opts())).toEqual({ deviceCode: null, connectorBearer: null });
    // Connecting again needs no new agreement to the same notice.
    await savePortalRelayLinking(linking, opts());
    expect((await readPortalRelay(opts()))?.state).toBe('linking');
  });

  it('keeps one row, and moves it to another portal only while the relay is off', async () => {
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: 'https://other.example.test' }, opts());
    expect((await readPortalRelay(opts()))?.portalOrigin).toBe('https://other.example.test');

    await recordPortalRelayConsent({ noticeVersion: 1, by: null }, opts());
    await savePortalRelayLinking({ ...linking, verificationUri: 'https://other.example.test/device' }, opts());
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    expect((await readPortalRelay(opts()))?.portalOrigin).toBe('https://other.example.test');

    const [{ n }] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.remote_access_portal_relay`;
    expect(n).toBe(1);
  });

  it('records and clears the last error, truncated to 2000 characters, and moves the operator port', async () => {
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    await recordPortalRelayError('x'.repeat(2500), opts());
    let row = await readPortalRelay(opts());
    expect(row?.lastError).toHaveLength(2000);
    expect(row?.lastErrorAt).toBeInstanceOf(Date);
    await recordPortalRelayError(null, opts());
    row = await readPortalRelay(opts());
    expect(row?.lastError).toBeNull();
    expect(row?.lastErrorAt).toBeNull();

    await setPortalRelayOperatorPort(3071, opts());
    expect((await readPortalRelay(opts()))?.operatorPort).toBe(3071);
  });

  it('coalesces concurrent link requests from independent one-connection PG clients', async () => {
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    await recordPortalRelayConsent({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION, by: 'owner' }, opts());
    const clients = [postgres(db.adminDsn, { max: 1 }), postgres(db.adminDsn, { max: 1 })];
    const requestCode = vi.fn(async () => ({
      deviceCode: DEVICE_CODE, userCode: linking.userCode, verificationUriComplete: linking.verificationUri,
      expiresIn: 600, interval: 5,
    }));
    try {
      const workers = clients.map((sql) => defaultPortalRelayDeps({
        env: {}, notifyChanged: () => {}, installLabel: () => 'existing-install',
        portal: { ...defaultPortalRelayDeps().portal, requestCode },
      }, { sql, encryptionKey: KEY }));
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => beginPortalRelayLink({ portalOrigin: PORTAL }, workers[i % workers.length]!)));
      expect(requestCode).toHaveBeenCalledTimes(1);
      expect(requestCode).toHaveBeenCalledWith(PORTAL, { installId: INSTALL, installLabel: 'existing-install' });
      for (const result of results) expect(result.pending).toEqual(results[0]!.pending);
      expect((await readPortalRelay(opts()))?.installId).toBe(INSTALL);
      expect(await readPortalRelaySecrets(opts())).toEqual({ deviceCode: DEVICE_CODE, connectorBearer: null });
    } finally {
      await Promise.all(clients.map((sql) => sql.end()));
    }
  });

  it('rolls back a failed lifecycle write and releases its lock for another client', async () => {
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    const client = postgres(db.adminDsn, { max: 1 });
    try {
      await expect(withPortalRelayLinkLock(async (txOpts) => {
        await recordPortalRelayConsent({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION, by: 'rolled-back' }, txOpts);
        throw new Error('cancel transaction');
      }, { sql: client, encryptionKey: KEY })).rejects.toThrow('cancel transaction');
      await withPortalRelayLinkLock(async (txOpts) => {
        expect((await readPortalRelay(txOpts))?.consentedAt).toBeNull();
        await recordPortalRelayConsent({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION, by: 'committed' }, txOpts);
      }, opts());
      expect((await readPortalRelay(opts()))?.consentedBy).toBe('committed');
    } finally {
      await client.end();
    }
  });

  async function desktopLinked() {
    await ensurePortalRelayRow({ installId: INSTALL, portalOrigin: PORTAL }, opts());
    await recordPortalRelayConsent({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION, by: 'local-owner' }, opts());
    await savePortalRelayLinked(linked, opts());
    return {
      version: 1, id: 'grant-1', installId: INSTALL, portalOrigin: PORTAL, userId: linked.userId,
      organizationId: linked.organizationId, customerWorkspaceId: linked.customerWorkspaceId,
      localWorkspaceId: 'real-local-workspace', browserPublicKey: Buffer.alloc(32, 4).toString('base64'),
      view: true, control: false, grantedAt: new Date().toISOString(),
    } satisfies PortalRelayDesktopGrant;
  }

  it('persists separate desktop consent across independent PG clients without changing the app credential', async () => {
    const grant = await desktopLinked();
    const client = postgres(db.adminDsn, { max: 1 });
    try {
      expect((await readPortalRelay(opts()))?.desktopGrant).toBeNull();
      expect(await savePortalRelayDesktopGrant(grant, opts())).toBe(true);
      const restarted = await readPortalRelay({ sql: client, encryptionKey: KEY });
      expect(currentPortalRelayDesktopGrant(restarted)).toEqual(grant);
      expect((await readPortalRelaySecrets(opts())).connectorBearer).toBe(BEARER);
      await clearPortalRelayDesktopGrant({ sql: client, encryptionKey: KEY });
      expect(currentPortalRelayDesktopGrant(await readPortalRelay(opts()))).toBeNull();
      expect((await readPortalRelay(opts()))?.state).toBe('linked');
      expect((await readPortalRelaySecrets(opts())).connectorBearer).toBe(BEARER);
    } finally { await client.end(); }
  });

  it.each(['installId', 'portalOrigin', 'userId', 'organizationId', 'customerWorkspaceId'] as const)('CAS refuses a foreign desktop %s', async (field) => {
    const grant = await desktopLinked();
    expect(await savePortalRelayDesktopGrant({ ...grant, [field]: 'foreign' }, opts())).toBe(false);
    expect((await readPortalRelay(opts()))?.desktopGrant).toBeNull();
  });

  it('database guard rejects incomplete, wrong-account and non-boolean desktop authority', async () => {
    const grant = await desktopLinked();
    for (const bad of [
      {}, { ...grant, userId: 'other' }, { ...grant, control: 'yes' }, { ...grant, view: false },
      { ...grant, browserPublicKey: 'bad' }, { ...grant, localWorkspaceId: '' },
      { ...grant, customerWorkspaceId: null }, { ...grant, version: 2 },
    ]) {
      await expect(db.adminSql`UPDATE harness_shared.remote_access_portal_relay SET desktop_grant = ${db.adminSql.json(bad)}`)
        .rejects.toThrow(/portal_relay_desktop_grant_binding_ck/);
    }
    expect((await readPortalRelay(opts()))?.desktopGrant).toBeNull();
  });

  it('unlink and relink clear desktop authority while retaining installation identity', async () => {
    const grant = await desktopLinked();
    await savePortalRelayDesktopGrant(grant, opts());
    await savePortalRelayLinking(linking, opts());
    expect(await readPortalRelay(opts())).toMatchObject({ installId: INSTALL, linkedUserId: null, desktopGrant: null });
    await savePortalRelayLinked(linked, opts());
    await savePortalRelayDesktopGrant(grant, opts());
    await setPortalRelayOff(null, opts());
    expect(await readPortalRelay(opts())).toMatchObject({ installId: INSTALL, linkedUserId: null, desktopGrant: null });
  });
});
