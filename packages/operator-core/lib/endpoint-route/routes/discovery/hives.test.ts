/**
 * hives.test.ts — the GET /api/discovery/hives HTTP route (p2p-hive-directory P-007).
 *
 * The desktop HiveDirectoryPanel fetches this loopback route. Verifies it
 * projects the directory's verified list, gates non-loopback callers with 403,
 * and never leaks a private hive.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import hivesRoute from './hives';
import { configureHiveDirectoryForTest, __resetHiveDirectorySingleton } from '../../../hive-directory-deps';
import type { HiveDirectoryDeps } from '../../../hive-directory';
import { buildHiveAnnounce, type HiveAnnounceBody, type SignedHiveAnnounce } from '../../../sync/hyperbee/hive-announce';

const NOW = 1_700_000_000_000;

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

async function announce(over: Partial<HiveAnnounceBody> = {}): Promise<SignedHiveAnnounce> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const body: HiveAnnounceBody = {
    hive_id: 'h',
    title: 'T',
    description: 'd',
    owner_github_login: 'alice',
    owner_github_user_id: 1,
    owner_device_pubkey: rawPubkeyBase64(publicKey),
    attestation_gist_id: 'g',
    member_topics: ['a'.repeat(64)],
    visibility: 'public',
    created_at: NOW - 1000,
    ts: NOW,
    ...over,
  };
  return buildHiveAnnounce(body, (b) => Promise.resolve(nodeSign(null, b, privateKey)));
}

const fakeDeps = (): HiveDirectoryDeps => ({
  sign: async (b) => Buffer.from(b),
  verifyAttestation: async () => true,
  broadcast: async () => {},
  now: () => NOW,
});

const call = async (url: string) => {
  const res = (await hivesRoute.handler(new Request(url) as never, {} as never)) as Response;
  return { status: res.status, body: await res.json().catch(() => null) };
};

const savedEnv = process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;

beforeEach(() => {
  delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
});

afterEach(() => {
  __resetHiveDirectorySingleton();
  if (savedEnv !== undefined) process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = savedEnv;
});

describe('GET /api/discovery/hives route (P-007)', () => {
  it('serves the discovered list to a loopback caller', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    await dir.ingestAnnounce(await announce({ hive_id: 'ash', title: 'Ash Hive', member_links: ['papercusp://harness?topic=a'] }));
    const { status, body } = await call('http://127.0.0.1/api/discovery/hives');
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.rows[0]).toMatchObject({ hiveId: 'ash', title: 'Ash Hive', memberLinks: ['papercusp://harness?topic=a'] });
  });

  it('403s a non-loopback caller via the declared loopback tier (auth-tier Wave 1)', async () => {
    // The perimeter moved from an in-handler guard to `auth: 'loopback'`,
    // enforced by the route-stack authStep — assert the declaration and the
    // mounted stack's rejection (the handler itself no longer gates).
    expect((hivesRoute as { auth?: unknown }).auth).toBe('loopback');
    const { Hono } = await import('hono');
    const { registerRoute } = await import('../../define-route');
    const app = new Hono();
    registerRoute(app, hivesRoute as never);
    configureHiveDirectoryForTest(fakeDeps());
    const res = await app.request('http://evil.example.com/discovery/hives');
    expect(res.status).toBe(403);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    expect(body?.error).toBe('loopback_only');
  });

  it('returns an empty list when nothing discovered', async () => {
    configureHiveDirectoryForTest(fakeDeps());
    const { status, body } = await call('http://localhost/api/discovery/hives');
    expect(status).toBe(200);
    expect(body).toMatchObject({ count: 0, rows: [] });
  });
});
