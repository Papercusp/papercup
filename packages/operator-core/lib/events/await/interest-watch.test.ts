/**
 * interest-watch.test.ts — pure-helper unit tests (P-008,
 * get-feedback-relevance-consults-2026-08-16). The SQL/sweep behaviour lives in
 * interest-watch.integration.test.ts against a real Postgres.
 */
import { describe, expect, it } from 'vitest';
import {
  computeSweepWindow,
  renderInterestSummary,
  INTEREST_WATERMARK_LAG_MS,
  type InterestMatch,
} from './interest-watch';

const T0 = 1_000_000_000_000; // arbitrary fixed epoch ms

describe('computeSweepWindow', () => {
  it('no blocker → window runs from the watermark to claimNow minus the lag guard', () => {
    const w = computeSweepWindow({ watermarkMs: T0, blockerMinIngestedAtMs: null, claimNowMs: T0 + 60_000 });
    expect(w).toEqual({ fromMs: T0, toMs: T0 + 60_000 - INTEREST_WATERMARK_LAG_MS });
  });

  it('a young un-embedded blocker HALTS the frontier 1ms before itself', () => {
    const blocker = T0 + 20_000;
    const w = computeSweepWindow({ watermarkMs: T0, blockerMinIngestedAtMs: blocker, claimNowMs: T0 + 60_000 });
    expect(w).toEqual({ fromMs: T0, toMs: blocker - 1 });
  });

  it('a blocker past the lag cap does not extend the window beyond the cap', () => {
    const claimNow = T0 + 60_000;
    const cap = claimNow - INTEREST_WATERMARK_LAG_MS;
    const w = computeSweepWindow({ watermarkMs: T0, blockerMinIngestedAtMs: cap + 5_000, claimNowMs: claimNow });
    expect(w).toEqual({ fromMs: T0, toMs: cap });
  });

  it('returns null when the frontier has not advanced past the watermark (blocker at the watermark)', () => {
    const w = computeSweepWindow({
      watermarkMs: T0,
      blockerMinIngestedAtMs: T0 + 1,
      claimNowMs: T0 + 60_000,
    });
    expect(w).toBeNull();
  });

  it('returns null when claimNow is within the lag guard of the watermark', () => {
    const w = computeSweepWindow({
      watermarkMs: T0,
      blockerMinIngestedAtMs: null,
      claimNowMs: T0 + INTEREST_WATERMARK_LAG_MS - 1,
    });
    expect(w).toBeNull();
  });
});

describe('renderInterestSummary', () => {
  const match = (owner: string, sim: number): InterestMatch => ({
    owner,
    session_id: 's',
    turn_idx: 1,
    ts: null,
    sim,
    excerpt: 'x',
  });

  it('names the count, distinct owners, and the top match', () => {
    const s = renderInterestSummary('release gate internals', [match('a', 0.91), match('b', 0.7), match('a', 0.6)]);
    expect(s).toContain('3 peer turn(s)');
    expect(s).toContain('2 agent(s)');
    expect(s).toContain('top a sim 0.91');
    expect(s).toContain('release gate internals');
  });

  it('truncates a long interest text', () => {
    const long = 'y'.repeat(200);
    const s = renderInterestSummary(long, [match('a', 0.9)]);
    expect(s).toContain('…');
    expect(s.length).toBeLessThan(200);
  });
});
