import { describe, expect, it, vi } from 'vitest';
import {
  reapOrphanedHetznerFrames,
  matchesRigNaming,
  OWNER_LABEL_KEY,
  DEFAULT_MIN_AGE_HOURS,
  type HetznerFrameInfo,
  type HetznerOrphanReaperDeps,
  type OwnerLiveness,
} from './hetzner-orphan-frame-reaper';

const NOW = Date.parse('2026-07-02T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function frame(o: Partial<HetznerFrameInfo> & { id: string }): HetznerFrameInfo {
  return { name: 'hzdeb1234', labels: {}, createdAt: hoursAgo(10), ...o };
}

function makeDeps(o: {
  frames: HetznerFrameInfo[];
  liveness?: Record<string, OwnerLiveness['sessionState']>;
}): HetznerOrphanReaperDeps & { destroyed: string[] } {
  const destroyed: string[] = [];
  return {
    destroyed,
    async listFrames() {
      return o.frames;
    },
    async resolveOwnerLiveness(ownerIds) {
      return ownerIds.map((ownerId) => ({ ownerId, sessionState: o.liveness?.[ownerId] ?? 'unknown' }));
    },
    async destroy(id) {
      destroyed.push(id);
    },
    now: () => NOW,
  };
}

describe('matchesRigNaming', () => {
  it('matches hzdeb* and pcusp-fed-* (case-insensitive)', () => {
    expect(matchesRigNaming('hzdeb1234')).toBe(true);
    expect(matchesRigNaming('HZDEB1234')).toBe(true);
    expect(matchesRigNaming('pcusp-fed-a')).toBe(true);
    expect(matchesRigNaming('papercusp-prod')).toBe(false);
    expect(matchesRigNaming('unrelated-server')).toBe(false);
  });
});

describe('reapOrphanedHetznerFrames', () => {
  it('destroys a rig-named frame whose owner is confirmed ended and old enough', async () => {
    const deps = makeDeps({
      frames: [frame({ id: '1', labels: { [OWNER_LABEL_KEY]: 'su-dead' }, createdAt: hoursAgo(10) })],
      liveness: { 'su-dead': 'ended' },
    });
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.destroyed).toEqual(['1']);
    expect(deps.destroyed).toEqual(['1']);
    expect(r.dryRun).toBe(false);
  });

  it('never touches a non-rig-named server, even with an ended-owner label', async () => {
    const deps = makeDeps({
      frames: [frame({ id: '1', name: 'papercusp-prod', labels: { [OWNER_LABEL_KEY]: 'su-dead' }, createdAt: hoursAgo(100) })],
      liveness: { 'su-dead': 'ended' },
    });
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.matchedRigNames).toBe(0);
    expect(r.destroyed).toEqual([]);
    expect(deps.destroyed).toEqual([]);
  });

  it('skips a rig-named frame with no owner label — never destroy what can\'t be verified', async () => {
    const deps = makeDeps({ frames: [frame({ id: '1', labels: {}, createdAt: hoursAgo(100) })] });
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.skippedNoOwnerLabel).toEqual(['1']);
    expect(r.destroyed).toEqual([]);
  });

  it.each(['live', 'parked', 'recorded', 'unknown'] as const)(
    'skips when owner sessionState is %s (only a confirmed "ended" owner qualifies)',
    async (state) => {
      const deps = makeDeps({
        frames: [frame({ id: '1', labels: { [OWNER_LABEL_KEY]: 'su-x' }, createdAt: hoursAgo(100) })],
        liveness: { 'su-x': state },
      });
      const r = await reapOrphanedHetznerFrames(deps);
      expect(r.skippedOwnerAlive).toEqual(['1']);
      expect(r.destroyed).toEqual([]);
    },
  );

  it('skips a confirmed-ended owner\'s frame that has not cleared the min-age grace window', async () => {
    const deps = makeDeps({
      frames: [frame({ id: '1', labels: { [OWNER_LABEL_KEY]: 'su-dead' }, createdAt: hoursAgo(0.5) })],
      liveness: { 'su-dead': 'ended' },
    });
    const r = await reapOrphanedHetznerFrames(deps, { minAgeHours: DEFAULT_MIN_AGE_HOURS });
    expect(r.skippedTooYoung).toEqual(['1']);
    expect(r.destroyed).toEqual([]);
  });

  it('a missing createdAt is treated as infinitely old (age gate never blocks it)', async () => {
    const deps = makeDeps({
      frames: [frame({ id: '1', labels: { [OWNER_LABEL_KEY]: 'su-dead' }, createdAt: undefined })],
      liveness: { 'su-dead': 'ended' },
    });
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.destroyed).toEqual(['1']);
  });

  it('dryRun classifies as "would destroy" but never calls destroy()', async () => {
    const deps = makeDeps({
      frames: [frame({ id: '1', labels: { [OWNER_LABEL_KEY]: 'su-dead' }, createdAt: hoursAgo(10) })],
      liveness: { 'su-dead': 'ended' },
    });
    const r = await reapOrphanedHetznerFrames(deps, { dryRun: true });
    expect(r.destroyed).toEqual(['1']);
    expect(r.dryRun).toBe(true);
    expect(deps.destroyed).toEqual([]); // the real destroy() was never invoked
  });

  it('one frame erroring on destroy does not abort the sweep — isolated per-frame', async () => {
    const deps = makeDeps({
      frames: [
        frame({ id: 'bad', labels: { [OWNER_LABEL_KEY]: 'su-dead' }, createdAt: hoursAgo(10) }),
        frame({ id: 'good', labels: { [OWNER_LABEL_KEY]: 'su-dead' }, createdAt: hoursAgo(10) }),
      ],
      liveness: { 'su-dead': 'ended' },
    });
    const destroy = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('hetzner 423 locked');
    });
    const r = await reapOrphanedHetznerFrames({ ...deps, destroy }, {});
    expect(r.destroyed).toEqual(['good']);
    expect(r.errors).toEqual([{ id: 'bad', error: 'hetzner 423 locked' }]);
  });

  it('multiple rig frames owned by different (both-ended) owners all reap independently', async () => {
    const deps = makeDeps({
      frames: [
        frame({ id: '1', labels: { [OWNER_LABEL_KEY]: 'su-a' }, createdAt: hoursAgo(10) }),
        frame({ id: '2', labels: { [OWNER_LABEL_KEY]: 'su-b' }, createdAt: hoursAgo(10) }),
      ],
      liveness: { 'su-a': 'ended', 'su-b': 'ended' },
    });
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.destroyed.sort()).toEqual(['1', '2']);
  });

  it('no rig-named servers at all is a clean no-op (no liveness call, nothing destroyed)', async () => {
    const deps = makeDeps({ frames: [frame({ id: '1', name: 'unrelated' })] });
    const resolveOwnerLiveness = vi.spyOn(deps, 'resolveOwnerLiveness');
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.destroyed).toEqual([]);
    expect(resolveOwnerLiveness).not.toHaveBeenCalled();
  });
});
