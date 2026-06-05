/**
 * P-070 emitter foundation — coverage for resolveUsageActor: the cached
 * resolver that turns the local machine's gh identity + device keypair into the
 * { githubUserId, devicePubkey } an emit needs, WITHOUT requiring a booted
 * substrate log. Returns null when gh is unauthenticated (emit is then skipped).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveUsageActor,
  _resetUsageActorCacheForTests,
} from './usage-actor';

const okIdentity = {
  kind: 'ok' as const,
  token: 'gho_x',
  githubUserId: 42,
  githubLogin: 'octocat',
};
const unauthIdentity = { kind: 'gh_auth_required' as const };

function deps(overrides: {
  identity?: () => Promise<typeof okIdentity | typeof unauthIdentity>;
} = {}) {
  return {
    resolveGithubIdentity:
      overrides.identity ?? vi.fn(async () => okIdentity),
    resolveKeychainId: vi.fn((id: number) => `${id}:fp`),
    loadKeypair: vi.fn(async (keychainId: string) => ({
      keychainId,
      pubkeyBase64: 'PUBKEY==',
    })),
  };
}

describe('resolveUsageActor', () => {
  beforeEach(() => _resetUsageActorCacheForTests());

  it('resolves { githubUserId, devicePubkey } when gh is authenticated', async () => {
    const d = deps();
    const actor = await resolveUsageActor(d);
    expect(actor).toEqual({ githubUserId: 42, devicePubkey: 'PUBKEY==' });
    expect(d.resolveKeychainId).toHaveBeenCalledWith(42);
    expect(d.loadKeypair).toHaveBeenCalledWith('42:fp');
  });

  it('returns null when gh is unauthenticated', async () => {
    const d = deps({ identity: vi.fn(async () => unauthIdentity) });
    expect(await resolveUsageActor(d)).toBeNull();
    expect(d.loadKeypair).not.toHaveBeenCalled();
  });

  it('caches a successful resolution — deps invoked once across two calls', async () => {
    const identity = vi.fn(async () => okIdentity);
    const d = deps({ identity });
    await resolveUsageActor(d);
    await resolveUsageActor(d);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(d.loadKeypair).toHaveBeenCalledTimes(1);
  });

  it('does not cache a null result — retries once gh becomes available', async () => {
    const identity = vi
      .fn<() => Promise<typeof okIdentity | typeof unauthIdentity>>()
      .mockResolvedValueOnce(unauthIdentity)
      .mockResolvedValueOnce(okIdentity);
    const d = deps({ identity });
    expect(await resolveUsageActor(d)).toBeNull();
    expect(await resolveUsageActor(d)).toEqual({
      githubUserId: 42,
      devicePubkey: 'PUBKEY==',
    });
    expect(identity).toHaveBeenCalledTimes(2);
  });
});
