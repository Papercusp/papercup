/**
 * hives.test.ts — the GET /api/discovery/pots HTTP route (p2p-hive-directory P-007).
 *
 * The desktop HiveDirectoryPanel fetches this loopback route. Verifies it
 * projects the directory's verified list, gates non-loopback callers with 403,
 * and never leaks a private hive.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import hivesRoute from './pots';
import { configureHiveDirectoryForTest, __resetHiveDirectorySingleton } from '../../../hive-directory-deps';
import type { HiveDirectoryDeps } from '../../../hive-directory';
import { buildHiveAnnounce, type HiveAnnounceBody, type SignedHiveAnnounce } from '../../../sync/hyperbee/hive-announce';

const remoteHiveFixture = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  hives: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: vi.fn(async () => ({ projects: remoteHiveFixture.projects })),
  };
});

vi.mock('../../../hive-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hive-store')>();
  return {
    ...actual,
    getHiveBySlug: vi.fn(async (_workspaceId: string, slug: string) => remoteHiveFixture.hives.get(slug) ?? null),
  };
});

// EI-7726: the handler fires a real, un-awaited `ensureHiveDirectoryWired(...)` on every
// GET (fire-and-forget lazy-wire — see hives.ts). Unmocked, that promise runs the REAL
// boot path (resolveLocalAnnounceIdentity, getSharedSwarm, wireHiveDirectoryAtBoot) against
// this box's actual workspace/keychain, which is never wired in a test process — it
// eventually rejects and hive-directory-boot.ts logs a `console.warn` for the real
// "papercusp" workspace. Because the promise is never awaited by the handler, that warn
// lands at an unpredictable later tick — sometimes mid-way through a LATER `it()` in this
// file — and vitest-fail-on-console then fails whichever test happened to be running at
// that moment (the reported "403s a non-loopback caller" failure was never actually about
// that test; it was collateral from this dangling promise). Sibling discovery-route tests
// (federation-status.test.ts, join-invite.test.ts, discover-join-flow.test.ts) already
// mock this same seam for the same reason — this file was the one gap. Stubbing it makes
// the fire-and-forget call an instant no-op, so no real boot code (and no console.warn)
// ever runs during this suite.
vi.mock('../../../hive-directory-boot', () => ({ ensureHiveDirectoryWired: vi.fn(async () => null) }));

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
  remoteHiveFixture.projects = [];
  remoteHiveFixture.hives.clear();
});

afterEach(() => {
  __resetHiveDirectorySingleton();
  if (savedEnv !== undefined) process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = savedEnv;
});

describe('GET /api/discovery/pots route (P-007)', () => {
  it('serves the discovered list to a loopback caller', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    await dir.ingestAnnounce(await announce({ hive_id: 'ash', title: 'Ash Hive', member_links: ['papercusp://harness?topic=a'] }));
    const { status, body } = await call('http://127.0.0.1/api/discovery/pots');
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.rows[0]).toMatchObject({ potId: 'ash', title: 'Ash Hive', memberLinks: ['papercusp://harness?topic=a'] });
  });

  it('projects hivePubkey so the Comb rollup can match listings to the announce (comb-hive-native-sharing P-001)', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    const pk = 'K'.repeat(43) + '=';
    await dir.ingestAnnounce(await announce({ hive_id: 'keyed', hive_pubkey: pk }));
    await dir.ingestAnnounce(await announce({ hive_id: 'unkeyed' }));
    const { body } = await call('http://127.0.0.1/api/discovery/pots');
    const rows = body.rows as Array<{ potId: string; hivePubkey: string | null }>;
    expect(rows.find((r) => r.potId === 'keyed')?.hivePubkey).toBe(pk);
    expect(rows.find((r) => r.potId === 'unkeyed')?.hivePubkey).toBeNull();
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
    const res = await app.request('http://evil.example.com/discovery/pots');
    expect(res.status).toBe(403);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    expect(body?.error).toBe('loopback_only');
  });

  it('returns an empty list when nothing discovered', async () => {
    configureHiveDirectoryForTest(fakeDeps());
    const { status, body } = await call('http://localhost/api/discovery/pots');
    expect(status).toBe(200);
    expect(body).toMatchObject({ count: 0, rows: [] });
  });

  it('includes a joined remote_hive view when self-admit succeeded before any directory announce was heard (WI-3267)', async () => {
    configureHiveDirectoryForTest(fakeDeps());
    const pk = 'P'.repeat(43) + '=';
    remoteHiveFixture.projects = [
      { slug: 'papercusp', path: '/home/tester/.papercusp-workspaces/clones/papercusp', harness_kind: 'hive', remote_hive: true, hive_pubkey: pk },
      { slug: 'owner-self', path: '/src/papercusp', harness_kind: 'hive', self_repo: true, hive_pubkey: 'SHOULD_NOT_LIST' },
    ];
    remoteHiveFixture.hives.set('papercusp', {
      homeSlug: 'papercusp',
      pubkeyBase64: pk,
      title: 'Papercusp',
      description: 'Self-admitted offline hive',
      createdAt: NOW - 500,
      updatedAt: NOW,
    });

    const { status, body } = await call('http://127.0.0.1/api/discovery/pots');

    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.rows[0]).toMatchObject({
      potId: 'papercusp',
      title: 'Papercusp',
      description: 'Self-admitted offline hive',
      owner: 'remote',
      visibility: 'invite',
      hivePubkey: pk,
      memberLinks: [],
    });
  });

  // WI-569 (su-34db4): the route's stated invariant "never leaks a private hive" was
  // asserted in the doc comment but UNTESTED. The `visibility !== 'private'` filter in
  // hives.ts is the defense-in-depth layer (the announce layer also withdraws private
  // hives via hive-set-listing.ts P-015) — pin it so a refactor can't silently leak one.
  it('NEVER leaks a private hive — the listing filters visibility:private even if one was ingested', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    await dir.ingestAnnounce(await announce({ hive_id: 'pub', visibility: 'public' }));
    await dir.ingestAnnounce(await announce({ hive_id: 'secret', visibility: 'private' }));
    const { status, body } = await call('http://127.0.0.1/api/discovery/pots');
    expect(status).toBe(200);
    const ids = (body.rows as Array<{ potId: string }>).map((r) => r.potId);
    expect(ids).toContain('pub');
    expect(ids).not.toContain('secret');
  });

  it('maps an invite-visibility hive to visibility:"invite" (joinable-by-link, still listed)', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    await dir.ingestAnnounce(await announce({ hive_id: 'inv', visibility: 'invite' }));
    const { body } = await call('http://127.0.0.1/api/discovery/pots');
    const row = (body.rows as Array<{ potId: string; visibility: string }>).find((r) => r.potId === 'inv');
    expect(row?.visibility).toBe('invite');
  });
});
