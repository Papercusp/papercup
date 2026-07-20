/**
 * origin-freshness — the PURE verdict (evaluateOriginFreshness / originFreshness). The DB/git
 * wiring (origin-freshness-watchdog.ts: tracking the origin-tip clock, alarming, escalation)
 * mirrors git-sync-stall-watchdog.ts's own scope split (that sibling's DB wiring is likewise
 * not separately unit-tested here — only its pure verdict is).
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/origin-freshness.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateOriginFreshness,
  originFreshness,
  DEFAULT_AHEAD_COUNT_MAX,
  DEFAULT_TIP_AGE_STALE_MS,
  type OriginFreshnessSnapshot,
} from './origin-freshness';

const H = 3_600_000;

describe('evaluateOriginFreshness', () => {
  it('nothing ahead (aheadCount 0) ⇒ ok, regardless of tip age', () => {
    const v = evaluateOriginFreshness({ aheadCount: 0, originTipAgeMs: 100 * H });
    expect(v.state).toBe('ok');
    expect(v.aheadCountStale).toBe(false);
    expect(v.tipAgeStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('aheadCount null (unknown / fresh seed) ⇒ ok', () => {
    const v = evaluateOriginFreshness({ aheadCount: null, originTipAgeMs: null });
    expect(v.state).toBe('ok');
  });

  it('negative aheadCount (defensive: local behind origin) ⇒ ok', () => {
    const v = evaluateOriginFreshness({ aheadCount: -1, originTipAgeMs: 100 * H });
    expect(v.state).toBe('ok');
  });

  it('ahead but young + small ⇒ ok (healthy backlog between ticks)', () => {
    const v = evaluateOriginFreshness({ aheadCount: 3, originTipAgeMs: 5 * 60_000 });
    expect(v.state).toBe('ok');
    expect(v.aheadCountStale).toBe(false);
    expect(v.tipAgeStale).toBe(false);
  });

  it('EI-13924: tip frozen >3h while local stayed ahead ⇒ stale (tipAgeStale)', () => {
    const v = evaluateOriginFreshness({ aheadCount: 25, originTipAgeMs: 3 * H + 60_000 });
    expect(v.state).toBe('stale');
    expect(v.tipAgeStale).toBe(true);
    expect(v.reason).toMatch(/not advanced/);
    expect(v.reason).toMatch(/25 commit/);
  });

  it('tip age exactly at the threshold is NOT yet stale (strictly greater-than)', () => {
    const v = evaluateOriginFreshness({ aheadCount: 5, originTipAgeMs: DEFAULT_TIP_AGE_STALE_MS });
    expect(v.tipAgeStale).toBe(false);
  });

  it('a big pile-up alarms on aheadCount alone, even with a fresh/unknown tip clock', () => {
    const v = evaluateOriginFreshness({ aheadCount: DEFAULT_AHEAD_COUNT_MAX, originTipAgeMs: null });
    expect(v.state).toBe('stale');
    expect(v.aheadCountStale).toBe(true);
    expect(v.tipAgeStale).toBe(false);
    expect(v.reason).toMatch(/backlog is piling up/);
  });

  it('aheadCount just under the max ⇒ not aheadCount-stale', () => {
    const v = evaluateOriginFreshness({ aheadCount: DEFAULT_AHEAD_COUNT_MAX - 1, originTipAgeMs: null });
    expect(v.aheadCountStale).toBe(false);
    expect(v.state).toBe('ok');
  });

  it('both signals firing ⇒ reason names both', () => {
    const v = evaluateOriginFreshness({ aheadCount: 999, originTipAgeMs: 10 * H });
    expect(v.state).toBe('stale');
    expect(v.aheadCountStale).toBe(true);
    expect(v.tipAgeStale).toBe(true);
    expect(v.reason).toMatch(/backlog is piling up/);
    expect(v.reason).toMatch(/origin looks frozen/);
  });

  it('thresholds are overridable', () => {
    const snap: OriginFreshnessSnapshot = { aheadCount: 5, originTipAgeMs: 10 * 60_000 };
    expect(evaluateOriginFreshness(snap, { aheadCountMax: 5 }).state).toBe('stale');
    expect(evaluateOriginFreshness(snap, { tipAgeStaleMs: 5 * 60_000 }).state).toBe('stale');
    expect(evaluateOriginFreshness(snap, { aheadCountMax: 100, tipAgeStaleMs: H }).state).toBe('ok');
  });
});

describe('originFreshness (the WI-5607-sketched thin alias)', () => {
  it('returns just the state string', () => {
    expect(originFreshness({ aheadCount: 0, originTipAgeMs: null })).toBe('ok');
    expect(originFreshness({ aheadCount: 25, originTipAgeMs: 4 * H })).toBe('stale');
  });
});
