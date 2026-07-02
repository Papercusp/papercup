/**
 * Unit tests for the P2P settings store's PURE core (p2p-work-distribution P-002):
 * layer merge, patch sanitization, schedule-window evaluation, and the
 * M10/X13/M16 foreign-work admission contract. KV round-trips are covered by
 * the route/resolver integration paths; everything here is side-effect free.
 */
import { describe, expect, it } from 'vitest';
import {
  bakedP2pDefaults,
  isWithinP2pWindows,
  mergeP2pLayers,
  P2P_STARTER_PROFILE,
  resolveForeignWorkAdmission,
  sanitizeP2pSettingsPatch,
  type P2pScheduleWindow,
  type P2pSettings,
} from './settings';

/** Local-time ms for a given weekday/hour/minute (uses a fixed known week). */
function at(day: number, hour: number, minute = 0): number {
  // 2026-06-28 is a Sunday (day 0) — walk forward to the wanted weekday.
  const d = new Date(2026, 5, 28 + day, hour, minute, 0, 0);
  return d.getTime();
}

describe('bakedP2pDefaults', () => {
  it('is structurally inert (M11): opt-in off, nothing accepted, kill-switch clear', () => {
    const s = bakedP2pDefaults();
    expect(s.optIn.mode).toBe('off');
    expect(s.optIn.fleets).toEqual([]);
    expect(s.optIn.maxConcurrentForeign).toBe(0);
    expect(s.killSwitch.engaged).toBe(false);
    expect(s.killSwitch.windDownGraceSec).toBeGreaterThan(0);
  });
});

describe('mergeP2pLayers', () => {
  it('merges field-level: an override flips one knob without restating its section', () => {
    const eff = mergeP2pLayers(
      bakedP2pDefaults(),
      { optIn: { mode: 'any-fleet', maxConcurrentForeign: 4 } },
      { optIn: { maxConcurrentForeign: 1 } },
    );
    expect(eff.optIn.mode).toBe('any-fleet'); // from the default layer
    expect(eff.optIn.maxConcurrentForeign).toBe(1); // overridden per-field
    expect(eff.killSwitch.engaged).toBe(false); // baked
  });

  it('never mutates the baked object and deep-copies arrays', () => {
    const baked = bakedP2pDefaults();
    const eff = mergeP2pLayers(baked, { optIn: { fleets: ['a'] } });
    eff.optIn.fleets.push('b');
    expect(baked.optIn.fleets).toEqual([]);
  });

  it('null/absent layers are no-ops', () => {
    expect(mergeP2pLayers(bakedP2pDefaults(), null, undefined)).toEqual(bakedP2pDefaults());
  });
});

describe('sanitizeP2pSettingsPatch', () => {
  it('drops unknown fields, bad modes, and out-of-range numbers (never widens access)', () => {
    const clean = sanitizeP2pSettingsPatch({
      optIn: { mode: 'everything', maxConcurrentForeign: 10_000, fleets: ['ok', 7, ''] },
      killSwitch: { engaged: 'yes', windDownGraceSec: 5 },
      extra: { nope: true },
    });
    expect(clean.optIn?.mode).toBeUndefined(); // invalid enum dropped
    expect(clean.optIn?.maxConcurrentForeign).toBeLessThanOrEqual(64); // clamped
    expect(clean.optIn?.fleets).toEqual(['ok']); // non-strings/empties dropped
    expect(clean.killSwitch?.engaged).toBeUndefined(); // non-boolean dropped
    expect(clean.killSwitch?.windDownGraceSec).toBe(30); // clamped up to the floor
    expect((clean as Record<string, unknown>).extra).toBeUndefined();
  });

  it('sanitizes windows: bad days/minutes dropped, valid ones kept', () => {
    const clean = sanitizeP2pSettingsPatch({
      optIn: {
        windows: [
          { days: [1, 2, 99], startMin: 540, endMin: 1020 },
          { days: [], startMin: 0, endMin: 100 }, // no days → dropped
          { days: [3], startMin: 'x', endMin: 100 }, // bad start → dropped
        ],
      },
    });
    expect(clean.optIn?.windows).toEqual([{ days: [1, 2], startMin: 540, endMin: 1020 }]);
  });

  it('returns {} for non-object input', () => {
    expect(sanitizeP2pSettingsPatch('nope')).toEqual({});
    expect(sanitizeP2pSettingsPatch(null)).toEqual({});
  });
});

describe('isWithinP2pWindows', () => {
  const weekdays9to17: P2pScheduleWindow[] = [{ days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 }];

  it('empty windows = always', () => {
    expect(isWithinP2pWindows([], at(0, 3))).toBe(true);
  });

  it('inside/outside a simple window', () => {
    expect(isWithinP2pWindows(weekdays9to17, at(1, 10))).toBe(true); // Mon 10:00
    expect(isWithinP2pWindows(weekdays9to17, at(1, 8, 59))).toBe(false); // Mon 08:59
    expect(isWithinP2pWindows(weekdays9to17, at(1, 17, 0))).toBe(false); // end-exclusive
    expect(isWithinP2pWindows(weekdays9to17, at(0, 10))).toBe(false); // Sunday
  });

  it('midnight-wrapping window covers both halves', () => {
    const night: P2pScheduleWindow[] = [{ days: [1], startMin: 22 * 60, endMin: 6 * 60 }];
    expect(isWithinP2pWindows(night, at(1, 23))).toBe(true); // Mon 23:00
    expect(isWithinP2pWindows(night, at(2, 5))).toBe(true); // Tue 05:00 (wrapped from Mon)
    expect(isWithinP2pWindows(night, at(2, 7))).toBe(false); // Tue 07:00
    expect(isWithinP2pWindows(night, at(1, 21))).toBe(false); // Mon 21:00
  });
});

function opted(overrides?: Partial<P2pSettings['optIn']>): P2pSettings {
  const s = bakedP2pDefaults();
  s.optIn = { mode: 'any-fleet', fleets: [], maxConcurrentForeign: 2, windows: [], ...overrides };
  return s;
}

describe('resolveForeignWorkAdmission (M10/X13/M16 contract)', () => {
  it('baked defaults refuse with opt-in-off and no wind-down', () => {
    const a = resolveForeignWorkAdmission(bakedP2pDefaults(), Date.now());
    expect(a.admitNewClaims).toBe(false);
    expect(a.refusalReason).toBe('opt-in-off');
    expect(a.windDownInFlight).toBe(false);
  });

  it('kill-switch beats everything: stop new claims + wind down in-flight (M10), bounded grace (X13)', () => {
    const s = opted();
    s.killSwitch.engaged = true;
    s.killSwitch.windDownGraceSec = 120;
    const a = resolveForeignWorkAdmission(s, Date.now());
    expect(a.admitNewClaims).toBe(false);
    expect(a.refusalReason).toBe('kill-switch');
    expect(a.windDownInFlight).toBe(true);
    expect(a.windDownGraceSec).toBe(120);
  });

  it('outside-window refuses NEW claims but does not wind down in-flight work', () => {
    const s = opted({ windows: [{ days: [1], startMin: 9 * 60, endMin: 17 * 60 }] });
    const a = resolveForeignWorkAdmission(s, at(0, 10)); // Sunday
    expect(a.admitNewClaims).toBe(false);
    expect(a.refusalReason).toBe('outside-window');
    expect(a.windDownInFlight).toBe(false);
  });

  it('opted-in inside window admits; selected-fleets exposes the fleet list', () => {
    const s = opted({ mode: 'selected-fleets', fleets: ['p2p-dist'] });
    const a = resolveForeignWorkAdmission(s, at(1, 10));
    expect(a.admitNewClaims).toBe(true);
    expect(a.refusalReason).toBeNull();
    expect(a.optedInFleets).toEqual(['p2p-dist']);
    expect(a.maxConcurrentForeign).toBe(2);
  });

  it('any-fleet mode exposes optedInFleets: null (grant/tier layer still gates)', () => {
    const a = resolveForeignWorkAdmission(opted(), at(1, 10));
    expect(a.optedInFleets).toBeNull();
  });
});

describe('P2P_STARTER_PROFILE (m18)', () => {
  it('is a working bounded opt-in: admits when applied over baked defaults', () => {
    const eff = mergeP2pLayers(bakedP2pDefaults(), P2P_STARTER_PROFILE);
    const a = resolveForeignWorkAdmission(eff, Date.now());
    expect(a.admitNewClaims).toBe(true);
    expect(a.maxConcurrentForeign).toBeGreaterThan(0);
    expect(a.maxConcurrentForeign).toBeLessThanOrEqual(4); // bounded, not unlimited
  });
});
