/**
 * Unit tests for resolveActorIdentity — the (user, device, session) triple (D-006,
 * distributed-coordination-shared-harness-2026-06-04 Phase 0.1). Pure: the device
 * resolver is injected, so no gh / network.
 */
import { describe, expect, it } from 'vitest';
import { resolveActorIdentity, actorUserKey, type ActorIdentity } from './actor-identity';

const SU_CTX = { isSuperuser: true, uiClientId: 'su-abc123', workspaceId: 'ws-1' };
const PU_CTX = { isPowerUser: true, uiClientId: 'pus-xyz', userId: 'user-7', workspaceId: 'ws-1' };

describe('resolveActorIdentity', () => {
  it('combines the sync session identity with the async device identity', async () => {
    const id = await resolveActorIdentity(SU_CTX, {
      resolveUsageActor: async () => ({ githubUserId: 4242, devicePubkey: 'pubAAA' }),
    });
    // session
    expect(id.ownerId).toBe('su-abc123');
    expect(id.source).toBe('omp-hook-session');
    expect(id.workspaceId).toBe('ws-1');
    // device
    expect(id.githubUserId).toBe(4242);
    expect(id.devicePubkey).toBe('pubAAA');
  });

  it('degrades device fields to null when gh is unauthenticated (best-effort)', async () => {
    const id = await resolveActorIdentity(SU_CTX, { resolveUsageActor: async () => null });
    expect(id.ownerId).toBe('su-abc123');
    expect(id.githubUserId).toBeNull();
    expect(id.devicePubkey).toBeNull();
  });

  it('a device-resolver error degrades to null, never breaks an attributable write', async () => {
    const id = await resolveActorIdentity(SU_CTX, {
      resolveUsageActor: async () => {
        throw new Error('gh network down');
      },
    });
    expect(id.ownerId).toBe('su-abc123');
    expect(id.githubUserId).toBeNull();
    expect(id.devicePubkey).toBeNull();
  });

  it('preserves the power-user acting-as human userId alongside the device identity', async () => {
    const id = await resolveActorIdentity(PU_CTX, {
      resolveUsageActor: async () => ({ githubUserId: 99, devicePubkey: 'pubP' }),
    });
    expect(id.ownerId).toBe('pus-xyz');
    expect(id.userId).toBe('user-7');
    expect(id.githubUserId).toBe(99);
  });

  it('still hard-errors on an unattributable ctx (coordination writes must be attributable)', async () => {
    await expect(resolveActorIdentity({}, { resolveUsageActor: async () => null })).rejects.toThrow(/cannot be attributed/);
  });
});

describe('actorUserKey — the best-effort stable user key', () => {
  function actor(over: Partial<ActorIdentity>): ActorIdentity {
    return {
      ownerId: 'su-1', ownerLabel: 'su · su-1', source: 'omp-hook-session',
      workspaceId: null, userId: null, githubUserId: null, devicePubkey: null, ...over,
    };
  }
  it('prefers the github user id', () => {
    expect(actorUserKey(actor({ githubUserId: 4242, userId: 'user-7' }))).toBe('gh:4242');
  });
  it('falls back to the acting-as human userId', () => {
    expect(actorUserKey(actor({ userId: 'user-7' }))).toBe('user-7');
  });
  it('falls back to the per-session ownerId when nothing stronger exists', () => {
    expect(actorUserKey(actor({ ownerId: 'su-solo' }))).toBe('su-solo');
  });
});
