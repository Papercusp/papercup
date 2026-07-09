/**
 * hives.test.ts — the discovery:pots endpoint (p2p-hive-directory P-005).
 *
 * Drives the tool handler over a test-configured HiveDirectory (fake seams),
 * asserting it projects the directory's verified list into browse rows and
 * never leaks a private hive.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import hivesTool from './pots';
import { configureHiveDirectoryForTest, __resetHiveDirectorySingleton } from '../../hive-directory-deps';
import type { HiveDirectoryDeps } from '../../hive-directory';
import { buildHiveAnnounce, type HiveAnnounceBody, type SignedHiveAnnounce } from '../../sync/hyperbee/hive-announce';

const remoteHiveFixture = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  hives: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: vi.fn(async () => ({ projects: remoteHiveFixture.projects })),
  };
});

vi.mock('../../hive-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hive-store')>();
  return {
    ...actual,
    getHiveBySlug: vi.fn(async (_workspaceId: string, slug: string) => remoteHiveFixture.hives.get(slug) ?? null),
  };
});

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

const call = async (args: unknown) => {
  const res = (await hivesTool.handler(
    (hivesTool.args as { parse: (x: unknown) => unknown }).parse(args) as never,
    {} as never,
  )) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  remoteHiveFixture.projects = [];
  remoteHiveFixture.hives.clear();
});

afterEach(() => __resetHiveDirectorySingleton());

describe('discovery:pots endpoint (P-005)', () => {
  it('returns an empty list when nothing has been discovered', async () => {
    configureHiveDirectoryForTest(fakeDeps());
    const out = await call({});
    expect(out).toEqual({ ok: true, count: 0, rows: [] });
  });

  it('projects a joined remote_hive view when offline self-admit materialized the hive before P2P discovery (WI-3267)', async () => {
    configureHiveDirectoryForTest(fakeDeps());
    const pk = 'P'.repeat(43) + '=';
    remoteHiveFixture.projects = [
      { slug: 'papercusp', path: '/home/tester/.papercusp-workspaces/clones/papercusp', harness_kind: 'hive', remote_hive: true, hive_pubkey: pk },
    ];
    remoteHiveFixture.hives.set('papercusp', {
      homeSlug: 'papercusp',
      pubkeyBase64: pk,
      title: 'Papercusp',
      description: 'Self-admitted offline hive',
      createdAt: NOW - 500,
      updatedAt: NOW,
    });

    const out = await call({});

    expect(out.count).toBe(1);
    expect(out.rows[0]).toMatchObject({
      hiveId: 'papercusp',
      title: 'Papercusp',
      description: 'Self-admitted offline hive',
      owner: 'remote',
      visibility: 'invite',
      hivePubkey: pk,
      memberLinks: [],
    });
  });

  it('projects discovered hives into browse rows (title/desc/owner/memberCount)', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    await dir.ingestAnnounce(
      await announce({ hive_id: 'ash', title: 'Ash Hive', description: 'shop work', member_topics: ['a'.repeat(64), 'b'.repeat(64)] }),
    );
    const out = await call({});
    expect(out.count).toBe(1);
    expect(out.rows[0]).toMatchObject({
      hiveId: 'ash',
      title: 'Ash Hive',
      description: 'shop work',
      owner: 'alice',
      visibility: 'public',
      memberCount: 2,
    });
  });

  it('includes invite hives but the row visibility reflects it', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    await dir.ingestAnnounce(await announce({ hive_id: 'inv', visibility: 'invite' }));
    const out = await call({});
    expect(out.rows[0].visibility).toBe('invite');
  });

  it('respects the limit', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    await dir.ingestAnnounce(await announce({ hive_id: 'h1', ts: NOW }));
    await dir.ingestAnnounce(await announce({ hive_id: 'h2', ts: NOW + 1 }));
    const out = await call({ limit: 1 });
    expect(out.count).toBe(1);
  });

  // DISC-3: the private filter runs BEFORE the limit slice. With the private
  // hive sorted FIRST (newest announce) and limit:1, the surviving row is the
  // PUBLIC one — if the slice ran before the filter, the newest-private row
  // would consume the single slot and the result would be empty.
  it('filters private hives BEFORE slicing to the limit (DISC-3)', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps());
    await dir.ingestAnnounce(
      await announce({ hive_id: 'pub', visibility: 'public', ts: NOW }),
    );
    await dir.ingestAnnounce(
      // Newest announce → sorts first; the private filter must still drop it.
      await announce({ hive_id: 'priv', visibility: 'private', ts: NOW + 1 }),
    );
    const out = await call({ limit: 1 });
    expect(out.count).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].hiveId).toBe('pub');
    expect(out.rows[0].visibility).toBe('public');
  });
});
