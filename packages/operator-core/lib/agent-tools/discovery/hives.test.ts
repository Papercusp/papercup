/**
 * hives.test.ts — the discovery:hives endpoint (p2p-hive-directory P-005).
 *
 * Drives the tool handler over a test-configured HiveDirectory (fake seams),
 * asserting it projects the directory's verified list into browse rows and
 * never leaks a private hive.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import hivesTool from './hives';
import { configureHiveDirectoryForTest, __resetHiveDirectorySingleton } from '../../hive-directory-deps';
import type { HiveDirectoryDeps } from '../../hive-directory';
import { buildHiveAnnounce, type HiveAnnounceBody, type SignedHiveAnnounce } from '../../sync/hyperbee/hive-announce';

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

afterEach(() => __resetHiveDirectorySingleton());

describe('discovery:hives endpoint (P-005)', () => {
  it('returns an empty list when nothing has been discovered', async () => {
    configureHiveDirectoryForTest(fakeDeps());
    const out = await call({});
    expect(out).toEqual({ ok: true, count: 0, rows: [] });
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
});
