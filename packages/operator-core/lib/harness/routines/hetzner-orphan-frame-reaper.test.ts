import { describe, expect, it, vi } from 'vitest';
import {
  reapOrphanedHetznerFrames,
  matchesRigNaming,
  isTransientNetworkError,
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
    // WI (hetzner-orphan-frame-reaper HTTP-401 flap): default to an instant no-op
    // backoff so the retry-around-a-non-transient-error path doesn't add real
    // wall-clock delay to every test in this file — tests that specifically
    // exercise the backoff behavior itself override this.
    async delay() {},
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
      frames: [
        frame({ id: '1', name: 'papercusp-prod', labels: { [OWNER_LABEL_KEY]: 'su-dead' }, createdAt: hoursAgo(100) }),
      ],
      liveness: { 'su-dead': 'ended' },
    });
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.matchedRigNames).toBe(0);
    expect(r.destroyed).toEqual([]);
    expect(deps.destroyed).toEqual([]);
  });

  it("skips a rig-named frame with no owner label — never destroy what can't be verified", async () => {
    const deps = makeDeps({ frames: [frame({ id: '1', labels: {}, createdAt: hoursAgo(100) })] });
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.skippedNoOwnerLabel).toEqual(['1']);
    expect(r.destroyed).toEqual([]);
  });

  it.each(['live', 'parked', 'draining', 'suspect', 'recorded', 'unknown'] as const)(
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

  it("skips a confirmed-ended owner's frame that has not cleared the min-age grace window", async () => {
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

  // EI-6868: a transient Hetzner connectivity blip surfaced as `TypeError: fetch failed`
  // and threw out of listFrames() every tick, wedging the routine (watchdog routine-failure).
  it('a transient "fetch failed" from listFrames is a clean no-op — does not throw, does not wedge the routine', async () => {
    const deps = makeDeps({ frames: [] });
    deps.listFrames = async () => {
      throw new TypeError('fetch failed');
    };
    const destroy = vi.spyOn(deps, 'destroy');
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.listError).toMatch(/fetch failed/);
    expect(r.scanned).toBe(0);
    expect(r.matchedRigNames).toBe(0);
    expect(r.destroyed).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('a transient network error carried on cause.code is also a clean no-op', async () => {
    const deps = makeDeps({ frames: [] });
    deps.listFrames = async () => {
      const e = new TypeError('fetch failed');
      (e as unknown as { cause: { code: string } }).cause = { code: 'ECONNREFUSED' };
      throw e;
    };
    const r = await reapOrphanedHetznerFrames(deps);
    expect(r.listError).toBeTruthy();
    expect(r.destroyed).toEqual([]);
  });

  it('a NON-transient listFrames error PERSISTING across every retry attempt still propagates (surfaces a genuine failure)', async () => {
    const deps = makeDeps({ frames: [] });
    let calls = 0;
    deps.listFrames = async () => {
      calls++;
      throw new Error('Hetzner API listServers failed (HTTP 401): unauthorized');
    };
    await expect(reapOrphanedHetznerFrames(deps)).rejects.toThrow(/401/);
    expect(calls).toBe(3); // DEFAULT_MAX_LIST_ATTEMPTS — a persistently bad token exhausts every attempt
  });

  // WI (hetzner-orphan-frame-reaper HTTP-401 flap): a real incident showed Hetzner's
  // own auth path can 401 on a ONE-OFF blip that clears on the very next call with
  // the SAME (unrotated, still-valid) token — confirmed live by re-hitting the API
  // with the exact token seconds after a routine-failure EI was filed and getting a
  // clean 200. Previously ANY single non-transient error surfaced immediately,
  // spamming a bug EI over a self-healing condition (the same "phantom routine-
  // failure" class already known for the network-transient path, just at the
  // HTTP-status layer instead). This proves the retry now absorbs that.
  describe('non-transient listFrames retry-then-recover (HTTP-401 flap)', () => {
    it('a single 401 that clears on retry is absorbed — never surfaces, never wedges', async () => {
      const deps = makeDeps({ frames: [] });
      let calls = 0;
      deps.listFrames = async () => {
        calls++;
        if (calls === 1) throw new Error('Hetzner API listServers failed (HTTP 401): unauthorized');
        return [];
      };
      const r = await reapOrphanedHetznerFrames(deps);
      expect(calls).toBe(2);
      expect(r.listError).toBeUndefined();
      expect(r.scanned).toBe(0);
    });

    it('a rig frame IS still processed normally once the retry recovers', async () => {
      const f = frame({ id: 'rig-1', labels: { [OWNER_LABEL_KEY]: 'owner-1' } });
      const deps = makeDeps({ frames: [f], liveness: { 'owner-1': 'ended' } });
      let calls = 0;
      deps.listFrames = async () => {
        calls++;
        if (calls === 1) throw new Error('Hetzner API listServers failed (HTTP 401): unauthorized');
        return [f];
      };
      const r = await reapOrphanedHetznerFrames(deps);
      expect(r.listError).toBeUndefined();
      expect(r.destroyed).toEqual(['rig-1']);
    });

    it('sleeps between attempts using the injected backoff (never a real timer in tests)', async () => {
      const deps = makeDeps({ frames: [] });
      const delays: number[] = [];
      deps.delay = async (ms: number) => {
        delays.push(ms);
      };
      let calls = 0;
      deps.listFrames = async () => {
        calls++;
        if (calls < 3) throw new Error('Hetzner API listServers failed (HTTP 401): unauthorized');
        return [];
      };
      const r = await reapOrphanedHetznerFrames(deps);
      expect(r.listError).toBeUndefined();
      expect(calls).toBe(3);
      expect(delays).toEqual([300, 900]); // one delay BETWEEN each of the 2 failed attempts, none after the final success
    });

    it('maxListAttempts is configurable — honors a caller-supplied cap', async () => {
      const deps = makeDeps({ frames: [] });
      let calls = 0;
      deps.listFrames = async () => {
        calls++;
        throw new Error('Hetzner API listServers failed (HTTP 401): unauthorized');
      };
      await expect(reapOrphanedHetznerFrames(deps, { maxListAttempts: 1 })).rejects.toThrow(/401/);
      expect(calls).toBe(1); // no retries at all when capped to 1
    });

    it('a TRANSIENT network error never burns a retry attempt (its own next-cadence retry already covers it)', async () => {
      const deps = makeDeps({ frames: [] });
      let calls = 0;
      deps.listFrames = async () => {
        calls++;
        throw new TypeError('fetch failed');
      };
      const r = await reapOrphanedHetznerFrames(deps);
      expect(calls).toBe(1); // returns immediately as a clean listError, not retried in-process
      expect(r.listError).toMatch(/fetch failed/);
    });
  });
});

describe('isTransientNetworkError', () => {
  it('classifies the fetch-failed / transport-error class as transient', () => {
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true);
    const withCause = new TypeError('fetch failed');
    (withCause as unknown as { cause: { code: string } }).cause = { code: 'ENOTFOUND' };
    expect(isTransientNetworkError(withCause)).toBe(true);
    const coded = new Error('connect ETIMEDOUT 1.2.3.4:443');
    (coded as unknown as { code: string }).code = 'ETIMEDOUT';
    expect(isTransientNetworkError(coded)).toBe(true);
    expect(isTransientNetworkError({ name: 'AbortError', message: 'The operation was aborted' })).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT classify a genuine/API/logic error as transient', () => {
    expect(isTransientNetworkError(new Error('Hetzner API listServers failed (HTTP 401): unauthorized'))).toBe(false);
    expect(isTransientNetworkError(new Error('unexpected boom'))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError('fetch failed')).toBe(false); // a bare string, not an error object
  });
});
