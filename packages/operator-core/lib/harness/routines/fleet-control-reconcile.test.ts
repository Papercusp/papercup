import { describe, it, expect, vi } from 'vitest';
import type { SessionState } from '../../agent-tools/coordination/presence-wakeability';
import {
  decideFleetWindDown,
  reconcileFleetControlStates,
  STALE_FLEET_FLOOR_MS,
  NON_TERMINAL_SESSION_STATES,
  type FleetControlReconcileDeps,
} from './fleet-control-reconcile';

const NOW = 1_800_000_000_000;
const OLD = NOW - STALE_FLEET_FLOOR_MS - 60_000;

const base = {
  updatedAtMs: OLD,
  nowMs: NOW,
  everMembers: new Set(['su-a', 'su-b']),
  liveMembers: new Set<string>(),
  livenessRead: 'ok' as const,
};

describe('decideFleetWindDown (pure) — every ambiguity resolves to SKIP', () => {
  it('winds down a stale fleet whose known members are all terminal', () => {
    const v = decideFleetWindDown(base);
    expect(v.windDown).toBe(true);
    if (v.windDown) expect(v.reason).toContain('terminal');
  });

  // ── The three skips that carry the safety argument ────────────────────────────
  // Wrongly winding down a LIVE fleet breaks scheduler fleet-scope admission for its
  // members (EI-12832); failing to wind down a dead one just preserves the status quo.
  // So each of these is checked against inputs that are otherwise a perfect wind-down.

  it('CONTROL: a DEGRADED liveness read never winds down, even when nothing looks alive', () => {
    // The dangerous shape: a failed read produces an EMPTY liveMembers set, which is
    // byte-identical to "everyone is dead". If this check were ordered after the
    // live-member test, a total liveness outage would wind down every fleet at once.
    const v = decideFleetWindDown({ ...base, livenessRead: 'degraded' });
    expect(v).toEqual({ windDown: false, skip: 'liveness-read-degraded' });
  });

  it('CONTROL: an EMPTY member set skips — fleetEverMembers cannot distinguish unknown from memberless', () => {
    const v = decideFleetWindDown({ ...base, everMembers: new Set() });
    expect(v).toEqual({ windDown: false, skip: 'no-members-known' });
  });

  it('CONTROL: a fleet touched recently skips regardless of member state', () => {
    const v = decideFleetWindDown({ ...base, updatedAtMs: NOW - 60_000 });
    expect(v).toEqual({ windDown: false, skip: 'too-recent' });
  });

  it('any live member keeps the fleet active', () => {
    const v = decideFleetWindDown({ ...base, liveMembers: new Set(['su-b']) });
    expect(v).toEqual({ windDown: false, skip: 'has-live-members' });
  });

  it("'suspect' is NOT a death certificate — a suspect member keeps its fleet alive", () => {
    // 'suspect' is an unresolved verdict. Treating it as terminal would wind down fleets
    // during exactly the transient presence blips it exists to represent.
    expect(NON_TERMINAL_SESSION_STATES.has('suspect')).toBe(true);
    expect(NON_TERMINAL_SESSION_STATES.has('parked')).toBe(true);
    expect(NON_TERMINAL_SESSION_STATES.has('draining')).toBe(true);
    expect(NON_TERMINAL_SESSION_STATES.has('ended')).toBe(false);
    expect(NON_TERMINAL_SESSION_STATES.has('recorded')).toBe(false);
  });

  it('the age floor is exact at the boundary', () => {
    expect(decideFleetWindDown({ ...base, updatedAtMs: NOW - STALE_FLEET_FLOOR_MS }).windDown).toBe(true);
    expect(decideFleetWindDown({ ...base, updatedAtMs: NOW - STALE_FLEET_FLOOR_MS + 1 }).windDown).toBe(false);
  });
});

/** Deps whose defaults describe one stale, fully-dead fleet. */
function deps(over: Partial<FleetControlReconcileDeps> = {}): FleetControlReconcileDeps {
  return {
    listActiveFleets: vi.fn(async () => [{ fleetSlug: 'dead-fleet', updatedAtMs: OLD }]),
    everMembers: vi.fn(async () => new Set(['su-a', 'su-b'])),
    sessionStates: vi.fn(async (ids: string[]) => {
      const m = new Map<string, SessionState | null>();
      for (const id of ids) m.set(id, 'ended');
      return m;
    }),
    windDown: vi.fn(async () => {}),
    nowMs: NOW,
    ...over,
  };
}

describe('reconcileFleetControlStates — IO wrapper', () => {
  it('winds down a stale, fully-dead fleet exactly once, with a reason', async () => {
    const d = deps();
    const res = await reconcileFleetControlStates(d);

    expect(res.woundDown).toEqual(['dead-fleet']);
    expect(d.windDown).toHaveBeenCalledTimes(1);
    const [slug, reason] = (d.windDown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(slug).toBe('dead-fleet');
    expect(String(reason)).toContain('fleet-control-reconcile');
  });

  it('does not report a stale wind-down after a newer resume wins the compare-and-set', async () => {
    let controlState: 'active' | 'winding-down' = 'active';
    let updatedAtMs = OLD;
    const d = deps({
      windDown: vi.fn(async (_slug, _reason, expected) => {
        // A leader resume lands after the reconcile snapshot but before its write.
        controlState = 'active';
        updatedAtMs = NOW;
        return controlState === expected.state && updatedAtMs === expected.updatedAtMs;
      }),
    });

    const res = await reconcileFleetControlStates(d);

    expect(res.woundDown).toEqual([]);
    expect(res.skipped['state-changed-since-snapshot']).toBe(1);
    expect(d.windDown).toHaveBeenCalledWith(
      'dead-fleet',
      expect.stringContaining('fleet-control-reconcile'),
      { state: 'active', updatedAtMs: OLD },
    );
  });

  it('THE GUARD: a fleet with one live member is left alone', async () => {
    const d = deps({
      sessionStates: vi.fn(async () =>
        new Map<string, SessionState | null>([
          ['su-a', 'ended'],
          ['su-b', 'live'],
        ]),
      ),
    });
    const res = await reconcileFleetControlStates(d);

    expect(res.woundDown).toEqual([]);
    expect(res.skipped['has-live-members']).toBe(1);
    expect(d.windDown).not.toHaveBeenCalled();
  });

  it('THE GUARD: a THROWING liveness read skips instead of winding down', async () => {
    // A total presence outage must not read as "the whole fleet died".
    const d = deps({
      sessionStates: vi.fn(async () => {
        throw new Error('presence unavailable');
      }),
    });
    const res = await reconcileFleetControlStates(d);

    expect(res.woundDown).toEqual([]);
    expect(res.skipped['liveness-read-degraded']).toBe(1);
    expect(d.windDown).not.toHaveBeenCalled();
  });

  it('a fleet with no known members is skipped, and liveness is never even read', async () => {
    const d = deps({ everMembers: vi.fn(async () => new Set<string>()) });
    const res = await reconcileFleetControlStates(d);

    expect(res.skipped['no-members-known']).toBe(1);
    expect(d.sessionStates).not.toHaveBeenCalled();
    expect(d.windDown).not.toHaveBeenCalled();
  });

  it('the per-tick cap bounds the blast radius', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ fleetSlug: `f${i}`, updatedAtMs: OLD }));
    const d = deps({ listActiveFleets: vi.fn(async () => many), cap: 3 });
    const res = await reconcileFleetControlStates(d);

    expect(res.woundDown).toHaveLength(3);
    expect(res.skipped['cap-reached']).toBe(7);
  });

  it('one fleet failing never aborts the pass', async () => {
    const d = deps({
      listActiveFleets: vi.fn(async () => [
        { fleetSlug: 'boom', updatedAtMs: OLD },
        { fleetSlug: 'fine', updatedAtMs: OLD },
      ]),
      everMembers: vi.fn(async (slug: string) => {
        if (slug === 'boom') throw new Error('membership read failed');
        return new Set(['su-a']);
      }),
    });
    const res = await reconcileFleetControlStates(d);

    expect(res.skipped['error']).toBe(1);
    expect(res.woundDown).toEqual(['fine']);
  });

  it('refuses to run without explicit IO deps rather than silently touching the live registry', async () => {
    await expect(reconcileFleetControlStates({})).rejects.toThrow(/IO deps/);
  });
});
