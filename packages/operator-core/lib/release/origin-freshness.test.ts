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

/**
 * WI-5738 — the detector-failure regression.
 *
 * The 2026-07-20 wedge ran for FIVE DAYS with this watchdog running the whole
 * time. Both of its signals were structurally pinned healthy because the
 * watchdog measured against `github_default_branch` (= `main`, the branch the
 * bridge INGESTS) instead of `refs/heads/staging` (the branch it EGRESSES).
 * main is fast-forwarded hourly by the release pipeline, so:
 *   - aheadCount stayed ~24, under the 50 threshold, and
 *   - the tracked tip never aged past ~1h, under the 3h threshold,
 * while the real egress target sat 358 commits and 5 days behind.
 *
 * The watchdog now measures against the egress watermark, AND alarms on the
 * publish leg's own explicit refusal — which had been recorded on every single
 * tick at metadata.own_head_publish.refused and raised nothing at all.
 */
describe('WI-5738 — a sustained publish refusal alarms on its own', () => {
  it('alarms on a sustained refusal even when BOTH inferred signals read healthy', () => {
    // The exact shape of the incident as the watchdog saw it.
    const v = evaluateOriginFreshness({
      aheadCount: 24, // < 50: measured against main, which the release pipeline keeps fresh
      originTipAgeMs: 60 * 60 * 1000, // 1h: main moved an hour ago, so "fresh"
      publishRefusedSweeps: 5,
      publishRefusalCode: 'total-over-cap',
    });
    expect(v.state).toBe('stale');
    expect(v.publishRefused).toBe(true);
    expect(v.aheadCountStale).toBe(false); // both inferred signals still read OK…
    expect(v.tipAgeStale).toBe(false); // …which is precisely why it went unseen
    expect(v.reason).toMatch(/REFUSED/);
    expect(v.reason).toMatch(/total-over-cap/);
  });

  it('alarms on a refusal even when there is nothing to push (ahead <= 0)', () => {
    // A refusal is a direct self-report, so it must not be swallowed by the
    // "nothing to push ⇒ definitionally healthy" early return.
    const v = evaluateOriginFreshness({
      aheadCount: 0,
      originTipAgeMs: null,
      publishRefusedSweeps: 4,
      publishRefusalCode: 'secrets',
    });
    expect(v.state).toBe('stale');
    expect(v.publishRefused).toBe(true);
  });

  it('debounces a transient refusal below the sweep threshold', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 1,
      originTipAgeMs: 0,
      publishRefusedSweeps: 1,
      publishRefusalCode: 'error',
    });
    expect(v.state).toBe('ok');
    expect(v.publishRefused).toBe(false);
  });

  it('a healthy pot with no refusal is unaffected (no new false alarms)', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 3,
      originTipAgeMs: 60_000,
      publishRefusedSweeps: 0,
      publishRefusalCode: null,
    });
    expect(v.state).toBe('ok');
    expect(v.publishRefused).toBe(false);
    expect(v.reason).toBeNull();
  });
});
