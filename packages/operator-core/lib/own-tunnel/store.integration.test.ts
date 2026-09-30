/**
 * store.integration.test.ts — the install's own-tunnel row (external-app-access P-009,
 * migration 1262) against REAL Postgres with every migration applied.
 *
 * Covers what the unit tests cannot: the tokens are stored as pgcrypto ciphertext (no column
 * holds either token in clear), they decrypt only with the right key, the table's CHECKs refuse
 * an incomplete Cloudflare row and an ingress port equal to the operator port, a manual save
 * wipes every Cloudflare field and secret, and the kill switch reports a missing row.
 *
 * The store takes `sql` and `encryptionKey` as options, so this test passes the admin client of
 * a throwaway migrated database directly; nothing is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import {
  deleteOwnTunnel,
  readOwnTunnel,
  readOwnTunnelSecrets,
  recordOwnTunnelError,
  saveCloudflareTunnel,
  saveManualTunnel,
  setOwnTunnelEnabled,
  setOwnTunnelOperatorPort,
} from './store';

const KEY = 'own-tunnel-integration-test-key';
const API_TOKEN = 'cf-api-token-PLAINTEXT-7f3a';
const RUN_TOKEN = 'cf-run-token-PLAINTEXT-91bc';

const cloudflare = {
  ingressPort: 3091,
  operatorPort: 3070,
  hostname: 'papercusp.example.test',
  accountId: 'acct-1',
  zoneId: 'zone-1',
  zoneName: 'example.test',
  tunnelId: 'tunnel-1',
  tunnelName: 'papercusp-install',
  dnsRecordId: 'dns-1',
  apiToken: API_TOKEN,
  runToken: RUN_TOKEN,
};

describe('own-tunnel store (real PG, migration 1262)', () => {
  let db: OrgTestDb;
  const opts = () => ({ sql: db.adminSql, encryptionKey: KEY });

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await deleteOwnTunnel(opts());
  });

  it('stores both tokens as ciphertext and decrypts them only with the right key', async () => {
    await saveCloudflareTunnel(cloudflare, opts());

    const raw = await db.adminSql<{ row: string }[]>`
      SELECT row_to_json(t)::text AS row FROM harness_shared.remote_access_own_tunnel t`;
    expect(raw).toHaveLength(1);
    expect(raw[0].row).not.toContain(API_TOKEN);
    expect(raw[0].row).not.toContain(RUN_TOKEN);

    expect(await readOwnTunnelSecrets(opts())).toEqual({ apiToken: API_TOKEN, runToken: RUN_TOKEN });
    await expect(readOwnTunnelSecrets({ sql: db.adminSql, encryptionKey: 'wrong-key' })).rejects.toThrow();

    const row = await readOwnTunnel(opts());
    expect(row).toMatchObject({
      mode: 'cloudflare',
      enabled: true,
      ingressPort: 3091,
      operatorPort: 3070,
      hostname: 'papercusp.example.test',
      cfTunnelId: 'tunnel-1',
      cfDnsRecordId: 'dns-1',
      lastError: null,
    });
  });

  it('keeps one row per install: a second save replaces the first', async () => {
    await saveCloudflareTunnel(cloudflare, opts());
    await saveCloudflareTunnel({ ...cloudflare, tunnelId: 'tunnel-2', runToken: 'second-run-token' }, opts());
    const [{ n }] = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.remote_access_own_tunnel`;
    expect(n).toBe(1);
    expect((await readOwnTunnel(opts()))?.cfTunnelId).toBe('tunnel-2');
    expect((await readOwnTunnelSecrets(opts())).runToken).toBe('second-run-token');
  });

  it('a manual save clears every Cloudflare field and both secrets', async () => {
    await saveCloudflareTunnel(cloudflare, opts());
    await recordOwnTunnelError('connector exited', opts());
    await saveManualTunnel({ ingressPort: 3092, operatorPort: 3070, hostname: 'me.ts.net' }, opts());

    const row = await readOwnTunnel(opts());
    expect(row).toMatchObject({
      mode: 'manual',
      enabled: true,
      ingressPort: 3092,
      hostname: 'me.ts.net',
      cfAccountId: null,
      cfZoneId: null,
      cfTunnelId: null,
      cfDnsRecordId: null,
      lastError: null,
    });
    expect(await readOwnTunnelSecrets(opts())).toEqual({ apiToken: null, runToken: null });
  });

  it('the table refuses an incomplete Cloudflare row and an ingress port equal to the operator port', async () => {
    await expect(db.adminSql`
      INSERT INTO harness_shared.remote_access_own_tunnel (mode, ingress_port) VALUES ('cloudflare', 3091)`).rejects.toThrow(
      /remote_access_own_tunnel_cloudflare_complete/,
    );
    await expect(
      saveManualTunnel({ ingressPort: 3070, operatorPort: 3070 }, opts()),
    ).rejects.toThrow(/remote_access_own_tunnel_ingress_not_operator/);
  });

  it('setOwnTunnelOperatorPort moves the tunnel but never onto the ingress port', async () => {
    await saveManualTunnel({ ingressPort: 3092, operatorPort: 3070 }, opts());
    await setOwnTunnelOperatorPort(3071, opts());
    expect((await readOwnTunnel(opts()))?.operatorPort).toBe(3071);
    await setOwnTunnelOperatorPort(3092, opts());
    expect((await readOwnTunnel(opts()))?.operatorPort).toBe(3071);
  });

  it('the kill switch flips enabled and reports false when there is no tunnel', async () => {
    expect(await setOwnTunnelEnabled(false, opts())).toBe(false);
    await saveManualTunnel({ ingressPort: 3092, operatorPort: 3070 }, opts());
    expect(await setOwnTunnelEnabled(false, opts())).toBe(true);
    expect((await readOwnTunnel(opts()))?.enabled).toBe(false);
    expect(await setOwnTunnelEnabled(true, opts())).toBe(true);
    expect((await readOwnTunnel(opts()))?.enabled).toBe(true);
  });

  it('records and clears the last error, truncated to 2000 characters', async () => {
    await saveManualTunnel({ ingressPort: 3092, operatorPort: 3070 }, opts());
    await recordOwnTunnelError('x'.repeat(2500), opts());
    let row = await readOwnTunnel(opts());
    expect(row?.lastError).toHaveLength(2000);
    expect(row?.lastErrorAt).toBeInstanceOf(Date);
    await recordOwnTunnelError(null, opts());
    row = await readOwnTunnel(opts());
    expect(row?.lastError).toBeNull();
    expect(row?.lastErrorAt).toBeNull();
  });
});
