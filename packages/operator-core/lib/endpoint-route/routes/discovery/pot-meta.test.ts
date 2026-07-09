/**
 * hive-meta.test.ts — GET /api/discovery/pot-meta (comb-hive-native-sharing
 * P-004/P-005), the owner's share-state projection behind the Share-Hive
 * dialog and the hive header's published-state chrome.
 *
 * Verifies: the loopback auth tier, the 400 on a missing potId, the
 * unpublished projection (found:false, visibility:null), the published
 * projection (meta + pubkey + fresh member repos), and that helper failures
 * (no keypair, no registry) degrade to nulls instead of a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import hiveMetaRoute from './pot-meta';
import type { HiveDirectoryMeta } from '../../../hive-publish';

let storedMeta: HiveDirectoryMeta | null = null;
let pubkey: string | null = null;
let memberRepos: string[] = [];
let pubkeyThrows = false;
let reposThrow = false;

vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));
vi.mock('../../../hive-directory-meta', () => ({
  getOwnedHiveMeta: vi.fn(async () => storedMeta),
}));
vi.mock('../../../identity/hive-keypair', () => ({
  loadHivePubkey: vi.fn(async () => {
    if (pubkeyThrows) throw new Error('keychain down');
    return pubkey;
  }),
}));
vi.mock('../../../hive-member-repos', () => ({
  deriveHiveMemberRepoRefs: vi.fn(async () => {
    if (reposThrow) throw new Error('registry down');
    return memberRepos;
  }),
}));

async function get(qs: string) {
  const req = new Request(`http://127.0.0.1/api/discovery/pot-meta${qs}`);
  const res = (await hiveMetaRoute.handler(req as never, {} as never)) as Response;
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

beforeEach(() => {
  storedMeta = null;
  pubkey = null;
  memberRepos = [];
  pubkeyThrows = false;
  reposThrow = false;
});

describe('GET /api/discovery/pot-meta (P-004/P-005)', () => {
  it('declares the loopback auth tier (auth-tier Wave 1)', () => {
    expect((hiveMetaRoute as { auth?: unknown }).auth).toBe('loopback');
  });

  it('400s a missing potId', async () => {
    const { status, body } = await get('');
    expect(status).toBe(400);
    expect(body?.code).toBe('invalid_args');
  });

  it('projects an unpublished hive as found:false / visibility:null with slug-fallback prefill', async () => {
    memberRepos = ['acme/web#11', 'acme/api'];
    const { status, body } = await get('?potId=acme');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      potId: 'acme',
      found: false,
      visibility: null,
      title: 'acme',
      description: '',
      inviteSecret: null,
      hivePubkey: null,
      memberRepos: ['acme/web#11', 'acme/api'],
    });
  });

  it('projects the owned meta + identity pubkey + fresh member repos for a published hive', async () => {
    storedMeta = {
      potId: 'acme',
      title: 'Acme Hive',
      description: 'the acme stack',
      visibility: 'invite',
      memberTopics: ['a'.repeat(64)],
      createdAt: 1,
      inviteSecret: 'deadbeef'.repeat(4),
    };
    pubkey = 'K'.repeat(43) + '=';
    memberRepos = ['acme/web#11'];
    const { body } = await get('?potId=acme');
    expect(body).toMatchObject({
      found: true,
      visibility: 'invite',
      title: 'Acme Hive',
      description: 'the acme stack',
      inviteSecret: 'deadbeef'.repeat(4),
      hivePubkey: pubkey,
      memberRepos: ['acme/web#11'],
    });
  });

  it('degrades helper failures (keychain / registry down) to nulls, never a 500', async () => {
    storedMeta = {
      potId: 'acme',
      title: 'Acme Hive',
      description: '',
      visibility: 'public',
      memberTopics: [],
      createdAt: 1,
    };
    pubkeyThrows = true;
    reposThrow = true;
    const { status, body } = await get('?potId=acme');
    expect(status).toBe(200);
    expect(body).toMatchObject({ found: true, visibility: 'public', hivePubkey: null, memberRepos: [] });
  });
});
