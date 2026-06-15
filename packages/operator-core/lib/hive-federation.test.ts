/**
 * hive-federation.test.ts — the swarm-binding re-key for shared Hives
 * (shared-hive-federation-2026-06-08 P-004). PG-free: the Hive identity read
 * (hive-store), the share-gate read (hive-directory-meta), and the membership
 * read (harness-registry) are mocked.
 *
 * Asserts the federation gate + membership resolution: a Hive HOME or a MEMBER
 * harness (hive_slug → home) federates over the Hive pubkey topic ONLY when the
 * Hive is directory-published (public/invite). A non-hive, an un-backfilled Hive,
 * a local-only / private Hive, or a member of one returns null (the caller falls
 * back to the gh/local binding → unchanged behavior).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBKEY = Buffer.alloc(32, 7).toString('base64');
type Vis = 'public' | 'invite' | 'private';

let hives: Map<string, { homeSlug: string; pubkeyBase64: string }>;
let metas: Map<string, { visibility: Vis }>;
let projects: Array<{ slug: string; hive_slug?: string; remote_hive?: boolean }>;

beforeEach(() => {
  vi.resetModules();
  hives = new Map();
  metas = new Map();
  projects = [];
  vi.doMock('./hive-store', () => ({
    getHiveBySlug: async (_ws: string, slug: string) => hives.get(slug) ?? null,
  }));
  vi.doMock('./hive-directory-meta', () => ({
    getOwnedHiveMeta: async (hiveId: string) => metas.get(hiveId) ?? null,
  }));
  vi.doMock('./harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects }),
  }));
});

afterEach(() => {
  vi.doUnmock('./hive-store');
  vi.doUnmock('./hive-directory-meta');
  vi.doUnmock('./harness-registry');
});

/** Register a Hive home with the given visibility. */
function publishHive(slug: string, visibility: Vis) {
  hives.set(slug, { homeSlug: slug, pubkeyBase64: PUBKEY });
  metas.set(slug, { visibility });
}

async function resolve(slug: string) {
  const { resolveHiveSwarmBinding } = await import('./hive-federation');
  return resolveHiveSwarmBinding('ws', slug);
}

describe('resolveHiveSwarmBinding — Hive home', () => {
  it('null for a non-hive harness (no identity, no membership)', async () => {
    expect(await resolve('a-harness')).toBeNull();
  });

  it('null for a Hive with no directory meta (local-only)', async () => {
    hives.set('myhive', { homeSlug: 'myhive', pubkeyBase64: PUBKEY });
    expect(await resolve('myhive')).toBeNull();
  });

  it('null for a private Hive (never announces on the DHT)', async () => {
    publishHive('myhive', 'private');
    expect(await resolve('myhive')).toBeNull();
  });

  it('federates a PUBLIC Hive home over its pubkey topic', async () => {
    publishHive('myhive', 'public');
    expect(await resolve('myhive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('federates an INVITE Hive home over its pubkey topic', async () => {
    publishHive('myhive', 'invite');
    expect(await resolve('myhive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });
});

describe('resolveHiveSwarmBinding — member harness (hive_slug)', () => {
  it('a member of a PUBLIC Hive federates over the HIVE topic', async () => {
    publishHive('myhive', 'public');
    projects = [{ slug: 'member-a', hive_slug: 'myhive' }];
    expect(await resolve('member-a')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('a member of a PRIVATE Hive stays local-only', async () => {
    publishHive('myhive', 'private');
    projects = [{ slug: 'member-a', hive_slug: 'myhive' }];
    expect(await resolve('member-a')).toBeNull();
  });

  it('a member whose Hive has no identity yet (un-backfilled) → null', async () => {
    metas.set('myhive', { visibility: 'public' }); // published but no identity row
    projects = [{ slug: 'member-a', hive_slug: 'myhive' }];
    expect(await resolve('member-a')).toBeNull();
  });

  it('a harness with no hive_slug is not a member → null', async () => {
    publishHive('myhive', 'public');
    projects = [{ slug: 'loner' }];
    expect(await resolve('loner')).toBeNull();
  });
});

describe('resolveHiveSwarmBinding — JOINED (remote) Hive (EI-681)', () => {
  it('a member of a JOINED hive federates over the hive-pubkey topic even with NO owned meta', async () => {
    // The joiner has the remote identity row (pubkey) + a remote_hive view home,
    // but NO owned directory meta (it never published — it joined). It must STILL
    // re-key to the hive-pubkey topic to share the OWNER's topic.
    hives.set('remotehive', { homeSlug: 'remotehive', pubkeyBase64: PUBKEY }); // no metas entry
    projects = [
      { slug: 'remotehive', remote_hive: true },
      { slug: 'joined-member', hive_slug: 'remotehive' },
    ];
    expect(await resolve('joined-member')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
    // The remote view home itself also re-keys (consistency).
    expect(await resolve('remotehive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('an UN-PUBLISHED OWNED hive (identity, no meta, NOT remote) still → null', async () => {
    // Same "no meta" shape as a joined hive, but NOT remote_hive → it is a local
    // owned hive that never published → must stay local (the local-only guard).
    hives.set('ownedhive', { homeSlug: 'ownedhive', pubkeyBase64: PUBKEY });
    projects = [
      { slug: 'ownedhive' }, // no remote_hive flag
      { slug: 'member-x', hive_slug: 'ownedhive' },
    ];
    expect(await resolve('member-x')).toBeNull();
    expect(await resolve('ownedhive')).toBeNull();
  });
});
