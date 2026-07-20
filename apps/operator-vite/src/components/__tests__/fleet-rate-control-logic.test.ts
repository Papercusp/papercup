/**
 * fleet-rate-control-logic.test.ts — Brief 20 (rate-limit-layer-v2-2026-06-05 P-013/P-014).
 *
 * Unit-tests the PURE derivation layer of `<FleetRateControl>` (headline usage%,
 * spend/agents formatting, paused count, max-draft validation). Mirrors the package
 * convention (adv-overview-logic): test the logic, not a full mount.
 */
import { describe, expect, it } from 'vitest';
import {
  headlineUsagePct,
  fmtSpend,
  fmtLiveAgents,
  fmtGoverned,
  pausedCount,
  parseMaxDraft,
  type FleetRateStatusWire,
} from '../adv/FleetRateControl';

const usage = (buckets: Array<{ key: string; usagePct: number | null }>): FleetRateStatusWire['usage'] => ({
  spendUsd: 0,
  calls: 0,
  buckets,
});

describe('headlineUsagePct', () => {
  it('is the WORST bucket usage% across buckets with a known ceiling', () => {
    expect(
      headlineUsagePct(
        usage([
          { key: 'anthropic:opus', usagePct: 25 },
          { key: 'anthropic:sonnet', usagePct: 60 },
        ]),
      ),
    ).toBe(60);
  });

  it('null when NO bucket exposes a ceiling (subscription paths) — never fabricated', () => {
    expect(headlineUsagePct(usage([{ key: 'unknown:self', usagePct: null }]))).toBeNull();
    expect(headlineUsagePct(usage([]))).toBeNull();
    expect(headlineUsagePct(undefined)).toBeNull();
  });

  it('ignores null buckets but keeps known ones', () => {
    expect(
      headlineUsagePct(
        usage([
          { key: 'unknown:self', usagePct: null },
          { key: 'anthropic:opus', usagePct: 12 },
        ]),
      ),
    ).toBe(12);
  });
});

describe('fmtSpend', () => {
  it('formats cents and sub-cent values distinctly', () => {
    expect(fmtSpend(1.234)).toBe('$1.23');
    expect(fmtSpend(0.0042)).toBe('$0.0042');
    expect(fmtSpend(0)).toBe('$0');
    expect(fmtSpend(undefined)).toBe('$0');
  });
});

describe('fmtLiveAgents', () => {
  it('renders the real fleet-wide live-agent count ALONE — never juxtaposed with the governed cap (P-005 "81/8" confusion)', () => {
    expect(fmtLiveAgents({ cap: 16, inFlight: 3, effective: 16, floor: 1, liveAgents: 12 })).toBe('12');
    expect(fmtLiveAgents({ cap: 8, inFlight: 0, effective: 8, floor: 1, liveAgents: 81 })).toBe('81');
    expect(fmtLiveAgents(undefined)).toBe('—');
  });

  it('shows a placeholder (not a dishonest inFlight fallback) when liveAgents is omitted', () => {
    expect(fmtLiveAgents({ cap: 16, inFlight: 3, effective: 16, floor: 1 })).toBe('—');
  });
});

describe('fmtGoverned', () => {
  it('renders governed in-flight / cap — a population-consistent pair — and surfaces eff only when AIMD adapted below cap', () => {
    expect(fmtGoverned({ cap: 16, inFlight: 3, effective: 16, floor: 1, liveAgents: 12 })).toBe('3 / 16');
    expect(fmtGoverned({ cap: 16, inFlight: 4, effective: 6, floor: 1, liveAgents: 12 })).toBe('4 / eff 6 / 16');
    expect(fmtGoverned(undefined)).toBe('—');
  });

  it('renders ∞ for a non-finite cap and 0 for a missing inFlight', () => {
    expect(fmtGoverned({ cap: Number.POSITIVE_INFINITY, inFlight: 2, effective: Number.POSITIVE_INFINITY, floor: 1, liveAgents: 5 })).toBe('2 / ∞');
  });
});

describe('pausedCount', () => {
  it('counts paused governor buckets', () => {
    expect(
      pausedCount([
        { key: 'a', paused: true, pausedUntil: '2026-06-05T00:00:00Z' },
        { key: 'b', paused: false, pausedUntil: null },
      ]),
    ).toBe(1);
    expect(pausedCount(undefined)).toBe(0);
  });
});

describe('parseMaxDraft', () => {
  it('accepts integers 1..ceiling; rejects everything else (no commit)', () => {
    expect(parseMaxDraft('5')).toBe(5);
    expect(parseMaxDraft(' 16 ')).toBe(16);
    expect(parseMaxDraft('0')).toBeNull();
    expect(parseMaxDraft('65')).toBeNull();
    expect(parseMaxDraft('2.5')).toBeNull();
    expect(parseMaxDraft('abc')).toBeNull();
    expect(parseMaxDraft('')).toBeNull();
  });
});
