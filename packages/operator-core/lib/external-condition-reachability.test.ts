import { describe, expect, it, vi } from 'vitest';
import { classifyExternalConditionReachability, readEventConditionReachability } from './external-condition-reachability';
import type { ComposedNodeRow } from './events/await/compose-store';

const NOW = '2026-08-27T12:00:00.000Z';

describe('external condition reachability', () => {
  it('treats a fire latch as authoritative satisfaction', () => {
    expect(classifyExternalConditionReachability({ firedAt: '2026-08-27T11:00:00.000Z' }, NOW)).toMatchObject({
      verdict: 'reachable',
      basis: 'fired',
      authoritative: true,
    });
  });

  it('treats a live resolver as reachable', () => {
    expect(classifyExternalConditionReachability({ liveResolver: true }, NOW)).toMatchObject({
      verdict: 'reachable',
      basis: 'live-resolver',
      authoritative: true,
    });
  });

  it.each([
    ['cancelled', 'cancelled-registration'],
    ['expired', 'expired-registration'],
  ] as const)('uses authoritative %s producer registration evidence', (registration, basis) => {
    expect(classifyExternalConditionReachability({ registration }, NOW)).toMatchObject({
      verdict: 'impossible',
      basis,
      authoritative: true,
    });
  });

  it('keeps missing registration unknown regardless of condition age', () => {
    const recent = classifyExternalConditionReachability({ registration: 'missing' }, NOW);
    const muchLater = classifyExternalConditionReachability({ registration: 'missing' }, '2036-08-27T12:00:00.000Z');
    expect(recent).toMatchObject({ verdict: 'unknown', basis: 'missing-registration', authoritative: false });
    expect(muchLater.verdict).toBe('unknown');
  });

  it('uses an announcement fire when the unconditional latch is unavailable', async () => {
    const reachability = await readEventConditionReachability('fleet:test:gate', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [{ firedAt: '2026-08-27T11:30:00.000Z', supersededAt: null }] as never,
        waiters: [],
        deliveries: [],
        fireLatch: null,
        composedRoot: null,
      }),
    });
    expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'fired', authoritative: true });
  });

  it('does not reuse a historical fire latch for a fresh announcement generation', async () => {
    const reachability = await readEventConditionReachability('invented:key', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [
          {
            causalGeneration: 2,
            firedAt: null,
            supersededAt: null,
            cancelledAt: null,
            expiresTs: '2026-08-27T13:00:00.000Z',
          },
          {
            causalGeneration: 1,
            firedAt: '2026-08-27T11:30:00.000Z',
            supersededAt: '2026-08-27T11:45:00.000Z',
          },
        ] as never,
        waiters: [],
        deliveries: [],
        fireLatch: { lastFiredAt: '2026-08-27T11:30:00.000Z' } as never,
        composedRoot: null,
      }),
    });
    expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'live-resolver', authoritative: true });
    expect(reachability.evidence).not.toContain('event fired at');
  });

  it('does not treat a cancelled consumer await as a cancelled producer registration', async () => {
    const reachability = await readEventConditionReachability('invented:key', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [],
        waiters: [{ cancelledAt: '2026-08-27T11:30:00.000Z' }] as never,
        deliveries: [],
        fireLatch: null,
        composedRoot: null,
      }),
    });
    expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'missing-registration' });
  });

  it('recognizes an active composed-root anchor without cataloguing synthetic keys', async () => {
    const loadComposedRoot = vi.fn(async (rootId: number): Promise<ComposedNodeRow | null> => ({
      id: rootId,
      rootId,
      parentId: null,
      subscriberId: 'su-composed',
      requiredCount: 1,
      firedCount: 0,
      firedAt: null,
      spec: { any: [{ event: 'gate:green' }] },
      wakeHandle: null,
      note: null,
      expiresTs: '2026-08-27T13:00:00.000Z',
      timeoutBehavior: 'wake',
      cancelledAt: null,
    }));
    const loadComposedRootAnchor = vi.fn(async (rootId: number) => ({
      awaitId: rootId + 1000,
      subscriberId: 'su-composed',
      wakeHandle: null,
    }));
    const inspect = async () => ({
      announcements: [],
      waiters: [],
      deliveries: [],
      fireLatch: null,
      composedRoot: null,
    });

    const reachability = await readEventConditionReachability('composed-root:395', {
      now: new Date(NOW),
      inspect,
      loadComposedRoot,
      loadComposedRootAnchor,
    });

    expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'live-resolver', authoritative: true });
    expect(loadComposedRoot).toHaveBeenCalledWith(395);
    expect(loadComposedRootAnchor).toHaveBeenCalledWith(395);
  });

  it('does not treat an arbitrary composed-root key as reachable', async () => {
    const loadComposedRoot = vi.fn(async (): Promise<ComposedNodeRow | null> => null);
    const loadComposedRootAnchor = vi.fn(async () => null);
    const reachability = await readEventConditionReachability('composed-root:395', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [],
        waiters: [],
        deliveries: [],
        fireLatch: null,
        composedRoot: null,
      }),
      loadComposedRoot,
      loadComposedRootAnchor,
    });

    expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'missing-registration', authoritative: false });
    expect(loadComposedRoot).toHaveBeenCalledWith(395);
    expect(loadComposedRootAnchor).not.toHaveBeenCalled();
  });
});
