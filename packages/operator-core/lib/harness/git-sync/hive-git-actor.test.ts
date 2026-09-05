import { describe, expect, it } from 'vitest';
import { pickHiveGitActor } from './hive-git-actor';
import type { GitServingRequest } from '../../sync/pot-git/serving-capability';

const request: GitServingRequest = { workspaceId: 'ws', installSlug: 'repo', potHomeSlug: 'hive',
  scope: { hive_id: 'stable-hive', repo_key: 'gh:123' } };
const identity = { githubUserId: 42, devicePubkeyBase64: 'serving-device', keychainId: 'serving-key' };

describe('Git actor requires authoritative serving evidence', () => {
  it('uses only the identity and repository generation the owner currently serves', () => {
    const now = Date.now();
    const capability = { ...request, v: 1, runtimeId: 'owner', identity,
      context: { ...request.scope, store_generation: 'sg2-1-' + 'a'.repeat(40) },
      issuedAtMs: now, expiresAtMs: now + 30_000 };
    expect(pickHiveGitActor({ status: 'ready', capability }, request)).toEqual({
      githubUserId: 42, devicePubkey: 'serving-device', keychainId: 'serving-key',
      source: 'serving-owner', capability,
    });
  });

  it.each([
    null, undefined, identity,
    { booted: true, identity }, { booted: false, identity: null },
    { githubUserId: 42, devicePubkey: 'gh-login-device' },
    { ownerReportsBooted: false }, { lastAdvertisedServingDevicePubkey: 'serving-device' },
    ...['unknown', 'absent', 'stopped', 'never-created'].map(status => ({ status, retryable: true, reason: 'not serving' })),
  ])('refuses legacy/absent evidence %# without a gh-login fallback', state => {
    expect(pickHiveGitActor(state, request)).toBeNull();
  });
});
