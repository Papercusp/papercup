/**
 * hive-beacon.test.ts — the C-2 beacon schema module (hive-network-surface P-005,
 * brief B-06). Pins:
 *   - makeBeacon clamps text to ≤120, floors counts to ≥0, pins v:1;
 *   - sanitizeBeacon validates + clamps, returns undefined (never throws) on
 *     unusable input, and NEVER rejects (the directory keeps the listing);
 *   - canonicalBeaconForSigning is a fixed-key-order projection over known fields;
 *   - isBeaconStale uses ts vs the TTL.
 */
import { describe, it, expect } from 'vitest';
import {
  BEACON_TEXT_MAX,
  BEACON_VERSION,
  DEFAULT_BEACON_STALE_MS,
  canonicalBeaconForSigning,
  isBeaconStale,
  makeBeacon,
  sanitizeBeacon,
  type HiveStatusBeacon,
} from './hive-beacon';

const TS = '2026-06-11T22:00:00.000Z';

describe('makeBeacon — publisher clamp', () => {
  it('pins v:1 and passes through well-formed values', () => {
    const b = makeBeacon({ liveAgents: 3, queueDepth: 7, focus: 'shipping the thing', lastCompleted: 'fixed the bug', ts: TS });
    expect(b).toEqual({ v: 1, liveAgents: 3, queueDepth: 7, focus: 'shipping the thing', lastCompleted: 'fixed the bug', ts: TS });
  });

  it('clamps focus + lastCompleted to ≤120 chars', () => {
    const long = 'x'.repeat(500);
    const b = makeBeacon({ liveAgents: 0, queueDepth: 0, focus: long, lastCompleted: long, ts: TS });
    expect(b.focus.length).toBe(BEACON_TEXT_MAX);
    expect(b.lastCompleted.length).toBe(BEACON_TEXT_MAX);
  });

  it('floors counts to non-negative integers', () => {
    const b = makeBeacon({ liveAgents: -4, queueDepth: 2.9, focus: '', lastCompleted: '', ts: TS });
    expect(b.liveAgents).toBe(0);
    expect(b.queueDepth).toBe(2);
  });

  it('coerces non-finite counts to 0', () => {
    const b = makeBeacon({ liveAgents: NaN, queueDepth: Infinity, focus: '', lastCompleted: '', ts: TS });
    expect(b.liveAgents).toBe(0);
    expect(b.queueDepth).toBe(0);
  });
});

describe('sanitizeBeacon — consumer clamp (never throws / never rejects)', () => {
  const good: HiveStatusBeacon = { v: 1, liveAgents: 2, queueDepth: 5, focus: 'a', lastCompleted: 'b', ts: TS };

  it('accepts a well-formed beacon unchanged', () => {
    expect(sanitizeBeacon(good)).toEqual(good);
  });

  it('clamps an OVERSIZE text field rather than rejecting', () => {
    const out = sanitizeBeacon({ ...good, focus: 'y'.repeat(1000) });
    expect(out).toBeDefined();
    expect(out!.focus.length).toBe(BEACON_TEXT_MAX);
  });

  it('returns undefined for a wrong/missing version', () => {
    expect(sanitizeBeacon({ ...good, v: 2 })).toBeUndefined();
    expect(sanitizeBeacon({ ...good, v: undefined })).toBeUndefined();
  });

  it('returns undefined for non-numeric counts or a missing ts', () => {
    expect(sanitizeBeacon({ ...good, liveAgents: 'lots' })).toBeUndefined();
    expect(sanitizeBeacon({ ...good, queueDepth: null })).toBeUndefined();
    expect(sanitizeBeacon({ ...good, ts: undefined })).toBeUndefined();
  });

  it('floors numeric counts and defaults missing text to empty', () => {
    const out = sanitizeBeacon({ v: 1, liveAgents: 4.7, queueDepth: -1, ts: TS });
    expect(out).toEqual({ v: 1, liveAgents: 4, queueDepth: 0, focus: '', lastCompleted: '', ts: TS });
  });

  it('returns undefined (never throws) on junk input', () => {
    expect(sanitizeBeacon(undefined)).toBeUndefined();
    expect(sanitizeBeacon(null)).toBeUndefined();
    expect(sanitizeBeacon('a string')).toBeUndefined();
    expect(sanitizeBeacon(42)).toBeUndefined();
    expect(sanitizeBeacon([])).toBeUndefined();
  });

  it('ignores unknown keys', () => {
    const out = sanitizeBeacon({ ...good, evil: { huge: 'x'.repeat(99999) } } as unknown);
    expect(out).toEqual(good);
    expect(out as unknown as Record<string, unknown>).not.toHaveProperty('evil');
  });
});

describe('canonicalBeaconForSigning — deterministic fixed-key-order projection', () => {
  it('emits the v1 keys in a fixed order regardless of input key order', () => {
    const a = canonicalBeaconForSigning({ ts: TS, focus: 'f', v: 1, queueDepth: 1, lastCompleted: 'l', liveAgents: 2 });
    const b = canonicalBeaconForSigning({ v: 1, liveAgents: 2, queueDepth: 1, focus: 'f', lastCompleted: 'l', ts: TS });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a!)).toEqual(['v', 'liveAgents', 'queueDepth', 'focus', 'lastCompleted', 'ts']);
  });

  it('drops unknown keys from the signed projection (inert injection)', () => {
    const out = canonicalBeaconForSigning({ v: 1, liveAgents: 1, queueDepth: 0, focus: '', lastCompleted: '', ts: TS, injected: 'evil' });
    expect(out as Record<string, unknown>).not.toHaveProperty('injected');
  });

  it('returns undefined for a non-object', () => {
    expect(canonicalBeaconForSigning(undefined)).toBeUndefined();
    expect(canonicalBeaconForSigning('nope')).toBeUndefined();
  });
});

describe('isBeaconStale', () => {
  const base: HiveStatusBeacon = { v: 1, liveAgents: 0, queueDepth: 0, focus: '', lastCompleted: '', ts: TS };
  const now = Date.parse(TS);

  it('fresh within the TTL', () => {
    expect(isBeaconStale(base, now + DEFAULT_BEACON_STALE_MS - 1)).toBe(false);
  });
  it('stale past the TTL', () => {
    expect(isBeaconStale(base, now + DEFAULT_BEACON_STALE_MS + 1)).toBe(true);
  });
  it('an unparseable ts is treated as stale', () => {
    expect(isBeaconStale({ ...base, ts: 'not-a-date' }, now)).toBe(true);
  });

  it('exposes BEACON_VERSION = 1', () => {
    expect(BEACON_VERSION).toBe(1);
  });
});
