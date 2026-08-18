/**
 * agent-orient-disclosures — the PURE half.
 *
 * These tests exist to pin ONE property, because it is the property the whole
 * feature is for and it is the one a well-meaning later edit will break:
 * **"nothing recorded" and "recorded nothing" must never collapse into each
 * other.** A normaliser that helpfully defaults a missing marker to `{}`, or a
 * renderer that treats `null` as "clean", re-creates on screen exactly the
 * false-clean reading the disclosure family was built to prevent.
 *
 * A deliberately-wrong CONTROL implementation is kept below rather than mutating
 * the real one, per the repo's falsifiability rule — so a reader can see the
 * assertions actually discriminate.
 */

import { describe, it, expect } from 'vitest';
import {
  ORIENT_DISCLOSURE_KEYS,
  collectOrientDisclosures,
  hasOrientDisclosures,
  type OrientDisclosures,
} from './agent-orient-disclosures';

/** A full payload carrying every marker, shaped as orient emits them. */
const ALL_SIX = {
  factsWithheld: { count: 3, reason: 'queen-loop steering withheld from a responsive caller' },
  factsNarrowed: {
    fold: 'never-drop',
    prefixes: ['dead-end:', 'wall:'],
    reason: "mode:'monitor' tick",
  },
  factEvictionDisclosures: [
    {
      scope: 'workspace',
      scopeRef: null,
      recentEvictedCount: 39,
      latestEvictedAt: '2026-08-18T20:27:46.976Z',
      meaning: 'a fact you expect may have been evicted, not never-asserted',
    },
  ],
  claimableTruncated: { shown: 4, truncatedByLimit: true as const, limit: 20, more: 'work_items:claimable' },
  announcedGatesTruncated: { shown: 8, total: 14, more: 'events:catalog' },
  recipesTruncated: { shown: 3, truncatedByLimit: true as const, limit: 3, more: 'recipes:search' },
};

describe('collectOrientDisclosures', () => {
  it('picks every marker the payload carried, verbatim', () => {
    const out = collectOrientDisclosures(ALL_SIX);
    expect(Object.keys(out).sort()).toEqual([...ORIENT_DISCLOSURE_KEYS].sort());
    // Verbatim, not reshaped: the popup renders the producer's own words.
    expect(out.factsWithheld).toEqual(ALL_SIX.factsWithheld);
    expect(out.announcedGatesTruncated).toEqual(ALL_SIX.announcedGatesTruncated);
  });

  it('ignores everything that is not a disclosure marker', () => {
    const out = collectOrientDisclosures({
      ...ALL_SIX,
      // Real orient payload neighbours — none of them belong to this family.
      claimable: [1, 2, 3],
      facts: [{ key: 'x' }],
      inbox: { summary: {} },
    } as never);
    expect(Object.keys(out).sort()).toEqual([...ORIENT_DISCLOSURE_KEYS].sort());
  });

  it('returns {} — not null — for an orient that cut nothing', () => {
    // THE central distinction. `{}` is the POSITIVE statement "this orient cut
    // nothing"; a reader gets `null` only when no recording exists at all.
    const out = collectOrientDisclosures({});
    expect(out).toEqual({});
    expect(out).not.toBeNull();
  });

  it('drops an EMPTY eviction array rather than recording a marker with nothing to say', () => {
    const out = collectOrientDisclosures({ factEvictionDisclosures: [] });
    expect(out.factEvictionDisclosures).toBeUndefined();
    expect(hasOrientDisclosures(out)).toBe(false);
  });

  it('never invents a marker the payload did not carry', () => {
    const out = collectOrientDisclosures({ factsWithheld: ALL_SIX.factsWithheld });
    for (const key of ORIENT_DISCLOSURE_KEYS) {
      if (key === 'factsWithheld') continue;
      expect(out[key], `${key} must stay ABSENT — a filled-in default is a false clean`)
        .toBeUndefined();
    }
  });

  it('treats null and undefined marker values as absent', () => {
    const out = collectOrientDisclosures({
      factsWithheld: undefined,
      factsNarrowed: null,
    } as never);
    expect(out).toEqual({});
  });
});

describe('hasOrientDisclosures', () => {
  it('is false for null, undefined and the empty recording', () => {
    expect(hasOrientDisclosures(null)).toBe(false);
    expect(hasOrientDisclosures(undefined)).toBe(false);
    expect(hasOrientDisclosures({})).toBe(false);
  });

  it('is true as soon as any one marker is present', () => {
    for (const key of ORIENT_DISCLOSURE_KEYS) {
      const one = { [key]: ALL_SIX[key] } as OrientDisclosures;
      expect(hasOrientDisclosures(one), `${key} alone must count as a disclosure`).toBe(true);
    }
  });
});

describe('CONTROL: a permanently-wrong implementation the assertions must reject', () => {
  /** The tempting "helpful" collector — it fills in absent markers with empty
   *  defaults. This is the exact regression the tests above exist to catch, kept
   *  here as a live control so a reader can see they discriminate rather than
   *  passing vacuously. Never mutate the real module to prove this. */
  function helpfulButWrong(payload: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ORIENT_DISCLOSURE_KEYS) {
      out[key] = payload[key] ?? (key === 'factEvictionDisclosures' ? [] : {});
    }
    return out;
  }

  it('the control fails the absence property that the real collector satisfies', () => {
    const wrong = helpfulButWrong({ factsWithheld: ALL_SIX.factsWithheld });
    // The control invents five markers out of nothing…
    expect(wrong.claimableTruncated).toBeDefined();
    // …where the real one leaves them absent.
    expect(collectOrientDisclosures({ factsWithheld: ALL_SIX.factsWithheld }).claimableTruncated)
      .toBeUndefined();
  });

  it('calibration: the real collector still reports a genuinely-present marker', () => {
    // Without this, the assertions above would also pass for a collector that
    // returned {} unconditionally.
    expect(collectOrientDisclosures(ALL_SIX).claimableTruncated).toEqual(ALL_SIX.claimableTruncated);
  });
});
