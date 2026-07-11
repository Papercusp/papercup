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

// EI-9534: the directory wire now gates on requestOnlyHost() (a pure env
// predicate). These unit tests must therefore pin PAPERCUSP_BACKGROUND_WORKERS
// deterministically — otherwise a run that inherits a request-only host's env
// (the dev-api drop-in sets it to 0 service-wide) would trip the new gate and
// red the pre-existing "force retries" wire test.
const savedBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;

afterEach(() => {
  if (savedBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
  else process.env.PAPERCUSP_BACKGROUND_WORKERS = savedBackgroundWorkers;
  vi.doUnmock('./sync/hyperbee/local-announce-identity');
  vi.doUnmock('./hive-directory-meta');
  vi.doUnmock('./identity/hive-keypair');
  vi.doUnmock('./hive-member-repos');
  vi.doUnmock('./sync/hyperbee/swarm');
  vi.restoreAllMocks();
});

describe('ensureHiveDirectoryWired', () => {
  it('force retries immediately after a failed unforced attempt', async () => {
    vi.resetModules();
    // Gate OFF (a background-workers host) so the wire proceeds to identity resolution.
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    // The unforced attempt drives the identity-resolution failure path, whose
    // best-effort catch in wireHiveDirectoryForWorkspace legitimately logs a skip
    // warning. Spy on it so vitest-fail-on-console doesn't red the run AND so we
    // assert the expected warning was emitted.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[hive-directory] boot-join skipped for workspace ws'),
    );

    await expect(ensureHiveDirectoryWired('ws')).resolves.toBeNull();
    expect(resolveLocalAnnounceIdentity).toHaveBeenCalledTimes(1);

    const wiring = await ensureHiveDirectoryWired('ws', { force: true });
    expect(wiring).not.toBeNull();
    expect(resolveLocalAnnounceIdentity).toHaveBeenCalledTimes(2);
    await wiring?.stop();
  });

  // EI-9534: a request-only SECONDARY host (PAPERCUSP_BACKGROUND_WORKERS=0 / :3170)
  // must NOT join the directory swarm — the single-writer bg-host owns it (EI-126).
  // Before the fix, the lazy wire (fired by a discovery/federation-status read)
  // resolved getSharedSwarm() + joined the global directory topic anyway, so the
  // secondary host grew to ~74 swarm connections + ~3.2 GB RSS and self-OOM-recycled.
  it('EI-9534: a request-only host (PAPERCUSP_BACKGROUND_WORKERS=0) never joins the directory swarm', async () => {
    vi.resetModules();
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '0'; // restored by afterEach
    const getSharedSwarm = vi.fn(async () => fakeSwarm());
    const resolveLocalAnnounceIdentity = vi.fn(); // must never be reached
    vi.doMock('./sync/hyperbee/swarm', () => ({ getSharedSwarm }));
    vi.doMock('./sync/hyperbee/local-announce-identity', () => ({ resolveLocalAnnounceIdentity }));
    vi.doMock('./hive-directory-meta', () => ({ listOwnedHiveMeta: vi.fn(async () => []) }));

    const { ensureHiveDirectoryWired, __resetHiveDirectoryWiring } = await import('./hive-directory-boot');
    __resetHiveDirectoryWiring();

    // `force` bypasses the 60s read-throttle — so a null here is the GATE firing,
    // not the debounce. The gate returns BEFORE any swarm/identity resolution.
    await expect(ensureHiveDirectoryWired('ws', { force: true })).resolves.toBeNull();
    expect(getSharedSwarm).not.toHaveBeenCalled();
    expect(resolveLocalAnnounceIdentity).not.toHaveBeenCalled();
  });
});
