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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
} from './portal-relay-store';

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
});
