/**
 * hive-set-listing.test.ts — the save→(withdraw|publish) composition shared by
 * the `discovery:set_pot` MCP tool and the POST /api/discovery/set-pot route
 * (p2p-hive-directory P-004 / hive-from-github-url P-015). The sibling HTTP
 * route is tested for its validation/forwarding; this pins the COMPOSITION
 * itself (DISC-2): the private withdraw path (tombstone + Cupboard unlist, both
 * best-effort) and the public/invite publish path (announce / skip / throw).
 *
 * Mocks the static deps (saveOwnedHiveMeta, getHiveDirectory) and the four
 * lazily-imported modules the branches reach for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveOwnedHiveMeta = vi.fn<(...a: any[]) => Promise<void>>(async () => {});
vi.mock('./hive-directory-meta', () => ({ saveOwnedHiveMeta: (...a: any[]) => saveOwnedHiveMeta(...a) }));

const getHiveDirectory = vi.fn<() => unknown>(() => ({}));
vi.mock('./hive-directory-deps', () => ({ getHiveDirectory: () => getHiveDirectory() }));

const withdrawHiveFromDirectory = vi.fn<(...a: any[]) => any>();
vi.mock('./hive-publish', () => ({ withdrawHiveFromDirectory: (...a: any[]) => withdrawHiveFromDirectory(...a) }));

const unlistHiveCupboardRows = vi.fn<(...a: any[]) => any>();
vi.mock('./cupboard/unlist-hive-rows', () => ({ unlistHiveCupboardRows: (...a: any[]) => unlistHiveCupboardRows(...a) }));

const ensureHiveDirectoryWired = vi.fn<(...a: any[]) => Promise<unknown>>(async () => null);
vi.mock('./hive-directory-boot', () => ({ ensureHiveDirectoryWired: (...a: any[]) => ensureHiveDirectoryWired(...a) }));

const republishHiveAfterMemberAdd = vi.fn<(...a: any[]) => any>();
vi.mock('./hive-publish-from-repo', () => ({ republishHiveAfterMemberAdd: (...a: any[]) => republishHiveAfterMemberAdd(...a) }));

import { setHiveListing } from './hive-set-listing';

const base = { potId: 'h', title: 'T' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  saveOwnedHiveMeta.mockResolvedValue(undefined);
  ensureHiveDirectoryWired.mockResolvedValue(null);
});

describe('setHiveListing — always persists first', () => {
  it('saves the meta before branching (public)', async () => {
    republishHiveAfterMemberAdd.mockResolvedValue({ announced: true });
    await setHiveListing({ ...base, visibility: 'public' }, 'ws');
    expect(saveOwnedHiveMeta).toHaveBeenCalledTimes(1);
    const [meta, ws] = saveOwnedHiveMeta.mock.calls[0];
    expect(meta).toMatchObject({ potId: 'h', title: 'T', visibility: 'public', workspaceId: 'ws' });
    expect(ws).toBe('ws');
  });
});

describe('setHiveListing — private = withdraw (DISC-2)', () => {
  it('tombstone sent + Cupboard unlisted → tombstoneSent/withdrawn true, announced false', async () => {
    withdrawHiveFromDirectory.mockResolvedValue({ withdrawn: true });
    unlistHiveCupboardRows.mockResolvedValue({ unlisted: 3 });
    const res = await setHiveListing({ ...base, visibility: 'private' }, 'ws');
    expect(res).toMatchObject({
      ok: true,
      visibility: 'private',
      saved: true,
      announced: false,
      withdrawn: true,
      tombstoneSent: true,
      cupboardUnlist: { unlisted: 3 },
    });
    // The publish path must NOT run for a private flip.
    expect(republishHiveAfterMemberAdd).not.toHaveBeenCalled();
  });

  it('withdraw throws → tombstoneSent false (passive TTL), still withdrawn', async () => {
    withdrawHiveFromDirectory.mockRejectedValue(new Error('keychain not wired'));
    unlistHiveCupboardRows.mockResolvedValue({ unlisted: 0 });
    const res = await setHiveListing({ ...base, visibility: 'private' }, 'ws');
    expect(res).toMatchObject({ visibility: 'private', withdrawn: true, tombstoneSent: false, announced: false });
  });

  it('Cupboard unlist throws → cupboardUnlist.failed:true (best-effort)', async () => {
    withdrawHiveFromDirectory.mockResolvedValue({ withdrawn: true });
    unlistHiveCupboardRows.mockRejectedValue(new Error('pg down'));
    const res = await setHiveListing({ ...base, visibility: 'private' }, 'ws');
    expect(res.tombstoneSent).toBe(true);
    expect(res.cupboardUnlist).toMatchObject({ failed: true, error: 'pg down' });
  });
});

describe('setHiveListing — public/invite = publish (DISC-2)', () => {
  it('republish announced:true → announced:true, publish carried, no announceError', async () => {
    republishHiveAfterMemberAdd.mockResolvedValue({ announced: true, extra: 'x' });
    const res = await setHiveListing({ ...base, visibility: 'public' }, 'ws');
    expect(res).toMatchObject({ ok: true, visibility: 'public', saved: true, announced: true });
    expect(res.publish).toMatchObject({ announced: true, extra: 'x' });
    expect(res.announceError).toBeUndefined();
    expect(ensureHiveDirectoryWired).toHaveBeenCalledWith('ws');
  });

  it("republish skipped → announceError 'publish skipped: <reason>', announced false", async () => {
    republishHiveAfterMemberAdd.mockResolvedValue({ skipped: 'no-repos' });
    const res = await setHiveListing({ ...base, visibility: 'public' }, 'ws');
    expect(res.announced).toBe(false);
    expect(res.announceError).toBe('publish skipped: no-repos');
    expect(res.publish).toBeUndefined();
  });

  it('republish throws → announceError set to the error message, announced false', async () => {
    republishHiveAfterMemberAdd.mockRejectedValue(new Error('boom'));
    const res = await setHiveListing({ ...base, visibility: 'public' }, 'ws');
    expect(res.announced).toBe(false);
    expect(res.announceError).toBe('boom');
  });

  it('invite path runs the SAME publish branch (carries inviteSecret into the saved meta)', async () => {
    republishHiveAfterMemberAdd.mockResolvedValue({ announced: true });
    const res = await setHiveListing({ ...base, visibility: 'invite', inviteSecret: 'sekret' }, 'ws');
    expect(res).toMatchObject({ visibility: 'invite', announced: true });
    expect(saveOwnedHiveMeta.mock.calls[0][0]).toMatchObject({ inviteSecret: 'sekret' });
    expect(republishHiveAfterMemberAdd).toHaveBeenCalledWith({ workspaceId: 'ws', potSlug: 'h' });
  });
});
