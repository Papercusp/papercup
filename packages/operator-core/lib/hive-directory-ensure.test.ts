/**
 * hive-directory-ensure.test.ts — lazy directory wire retry guard.
 *
 * A browse/status read can attempt wiring before local identity is ready. Publish
 * is a user action that needs transport now, so it must be able to bypass that
 * read-side one-minute throttle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

function fakeSwarm() {
  return {
    join() {
      return {};
    },
    leave() {},
    on() {},
    off() {},
  };
}

afterEach(() => {
  vi.doUnmock('./sync/hyperbee/local-announce-identity');
  vi.doUnmock('./hive-directory-meta');
  vi.doUnmock('./identity/hive-keypair');
  vi.doUnmock('./hive-member-repos');
  vi.doUnmock('./sync/hyperbee/swarm');
});

describe('ensureHiveDirectoryWired', () => {
  it('force retries immediately after a failed unforced attempt', async () => {
    vi.resetModules();
    const resolveLocalAnnounceIdentity = vi
      .fn()
      .mockRejectedValueOnce(new Error('gh auth not ready'))
      .mockResolvedValue({
        githubLogin: 'alice',
        githubUserId: 1,
        devicePubkeyBase64: Buffer.alloc(32, 1).toString('base64'),
        attestationGistId: 'gist',
        keychainId: 'kc',
      });

    vi.doMock('./sync/hyperbee/local-announce-identity', () => ({ resolveLocalAnnounceIdentity }));
    vi.doMock('./hive-directory-meta', () => ({ listOwnedHiveMeta: vi.fn(async () => []) }));
    vi.doMock('./identity/hive-keypair', () => ({ loadHivePubkey: vi.fn(async () => null) }));
    vi.doMock('./hive-member-repos', () => ({ deriveHiveMemberRepoRefs: vi.fn(async () => []) }));
    vi.doMock('./sync/hyperbee/swarm', () => ({ getSharedSwarm: vi.fn(async () => fakeSwarm()) }));

    const { ensureHiveDirectoryWired, __resetHiveDirectoryWiring } = await import('./hive-directory-boot');
    __resetHiveDirectoryWiring();

    await expect(ensureHiveDirectoryWired('ws')).resolves.toBeNull();
    expect(resolveLocalAnnounceIdentity).toHaveBeenCalledTimes(1);

    await expect(ensureHiveDirectoryWired('ws')).resolves.toBeNull();
    expect(resolveLocalAnnounceIdentity).toHaveBeenCalledTimes(1);

    const wiring = await ensureHiveDirectoryWired('ws', { force: true });
    expect(wiring).not.toBeNull();
    expect(resolveLocalAnnounceIdentity).toHaveBeenCalledTimes(2);
    await wiring?.stop();
  });
});
