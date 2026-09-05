import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveSwarmTopic } from '../hyperbee/derive-swarm-topic';
import {
  GIT_SERVING_LEASE_MS, assertGitServingCapability, gitServingUnavailable, guardGitServingSigner,
  issueGitServingCapability, validateGitServingState,
  type GitServingCapability, type GitServingRequest, type GitServingState, type LiveGitServingOwner,
} from './serving-capability';

const request: GitServingRequest = { workspaceId: 'ws', installSlug: 'repo', potHomeSlug: 'hive',
  scope: { hive_id: Buffer.alloc(32, 1).toString('base64'), repo_key: 'gh:123' } };
const identity = { devicePubkeyBase64: Buffer.alloc(32, 2).toString('base64'), githubUserId: 42, keychainId: 'member-key' };
const context = { ...request.scope, store_generation: `sg2-1-${'a'.repeat(40)}` };
const owner: LiveGitServingOwner = { runtimeId: 'owner-1', workspaceId: 'ws', potHomeSlug: 'hive', identity,
  topicHex: deriveSwarmTopic({ kind: 'hive', hive_pubkey: request.scope.hive_id }).toString('hex') };
function ready(at = Date.now()): { status: 'ready'; capability: GitServingCapability } {
  return { status: 'ready', capability: { ...request, v: 1, runtimeId: owner.runtimeId, identity, context,
    issuedAtMs: at, expiresAtMs: at + GIT_SERVING_LEASE_MS } };
}
afterEach(() => vi.useRealTimers());

describe('P514 serving authority', () => {
  it('issues exactly the serving identity and D021 store context', async () => {
    const resolveContext = vi.fn(async () => context);
    const answer = await issueGitServingCapability(request, { current: () => owner, resolveContext, now: () => 100 });
    expect(answer).toEqual(ready(100));
    expect(resolveContext).toHaveBeenCalledWith(request, identity.devicePubkeyBase64);
  });

  it.each(['workspace', 'home', 'topic'] as const)('refuses a different %s before store allocation', async mismatch => {
    const wrong = { ...owner, ...(mismatch === 'workspace' ? { workspaceId: 'elsewhere' } :
      mismatch === 'home' ? { potHomeSlug: 'elsewhere' } : { topicHex: 'f'.repeat(64) }) };
    const resolveContext = vi.fn(async () => context);
    expect(await issueGitServingCapability(request, { current: () => wrong, resolveContext })).toMatchObject({ status: 'absent', retryable: true });
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it('distinguishes stopped, never-created and unreadable stores', async () => {
    expect(await issueGitServingCapability(request, { current: () => null, resolveContext: async () => context })).toMatchObject({ status: 'stopped' });
    expect(await issueGitServingCapability(request, { current: () => owner, resolveContext: async () => null })).toMatchObject({ status: 'never-created' });
    expect(await issueGitServingCapability(request, { current: () => owner, resolveContext: async () => { throw new Error('PG unreachable'); } })).toMatchObject({ status: 'unknown', retryable: true });
  });

  it.each(['close', 'restart', 'rekey'] as const)('invalidates a %s during generation issuance', async transition => {
    let current: LiveGitServingOwner | null = owner;
    const result = await issueGitServingCapability(request, { current: () => current, resolveContext: async () => {
      current = transition === 'close' ? null : { ...owner, runtimeId: 'owner-2',
        ...(transition === 'rekey' ? { identity: { ...identity, devicePubkeyBase64: 'other' } } : {}) };
      return context;
    } });
    expect(result).toMatchObject({ status: 'stopped', retryable: true });
  });

  it('rejects an expired lease even in a fresh discovery row', () => {
    expect(validateGitServingState(ready(100), request, 100 + GIT_SERVING_LEASE_MS)).toMatchObject({ status: 'unknown' });
  });

  it.each(['scope', 'generation', 'identity', 'future', 'duration'] as const)('refuses malformed %s evidence', field => {
    const state = ready(100);
    if (field === 'scope') state.capability.context = { ...context, repo_key: 'other' };
    if (field === 'generation') state.capability.context = { ...context, store_generation: 'hash-only-legacy' };
    if (field === 'identity') state.capability.identity = { ...identity, keychainId: '' };
    if (field === 'future') state.capability.issuedAtMs = 101;
    if (field === 'duration') state.capability.expiresAtMs++;
    expect(validateGitServingState(state, request, 100)).toMatchObject({ status: 'unknown', retryable: true });
  });

  it.each(['unknown', 'absent', 'stopped', 'never-created'] as const)('never signs on %s evidence', status => {
    const sign = vi.fn(async () => Buffer.from('signature'));
    const guarded = guardGitServingSigner(ready().capability, request, async () => gitServingUnavailable(status, 'test'), sign);
    return expect(guarded(Buffer.from('payload'))).rejects.toMatchObject({ code: 'GIT_SERVING_UNAVAILABLE', retryable: true })
      .then(() => expect(sign).not.toHaveBeenCalled());
  });

  it.each(['runtime', 'generation', 'device', 'keychain'] as const)('rejects %s replacement before publication', async changed => {
    const old = ready();
    const next = ready();
    if (changed === 'runtime') next.capability.runtimeId = 'owner-2';
    if (changed === 'generation') next.capability.context = { ...context, store_generation: `sg2-2-${'b'.repeat(40)}` };
    if (changed === 'device') next.capability.identity = { ...identity, devicePubkeyBase64: 'other-device' };
    if (changed === 'keychain') next.capability.identity = { ...identity, keychainId: 'other-key' };
    await expect(assertGitServingCapability(old.capability, request, async () => next)).rejects.toMatchObject({ retryable: true });
  });

  it('discards a signature if the owner restarts while the keychain is signing', async () => {
    const before = ready();
    let current: GitServingState = before;
    const guarded = guardGitServingSigner(before.capability, request, async () => current, async () => {
      current = { status: 'ready', capability: { ...before.capability, runtimeId: 'restarted' } };
      return Buffer.from('must-not-escape');
    });
    await expect(guarded(Buffer.from('payload'))).rejects.toMatchObject({ retryable: true });
  });

  it('renews after a long operation only when the same owner and generation still serve', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const old = ready();
    vi.setSystemTime(100 + GIT_SERVING_LEASE_MS + 1);
    const guarded = guardGitServingSigner(old.capability, request, async () => ready(), async () => Buffer.from('signed'));
    expect(await guarded(Buffer.from('payload'))).toEqual(Buffer.from('signed'));
  });
});
