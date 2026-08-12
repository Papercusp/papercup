import { describe, expect, it } from 'vitest';
import { assessClaimFreshness, createBugFreshnessEnvelope } from './work-item-claim-freshness';

const NOW = Date.parse('2026-08-11T20:00:00.000Z');
const current = { headSha: 'abc1234', runtimeSha: 'abc1234', runtimeVersion: '1.2.3' };

describe('claim-time bug freshness (P-014)', () => {
  it('routes a current-generation, recently reproduced bug to implementation', () => {
    const envelope = createBugFreshnessEnvelope({
      now: '2026-08-11T19:00:00.000Z',
      sourceSha: 'abc1234',
      runtimeSha: 'abc1234',
      reporterSession: 'su-a',
      reporterRuntimeVersion: '1.2.3',
      lastSuccessfulReproductionAt: '2026-08-11T19:30:00.000Z',
    });
    expect(assessClaimFreshness({ freshnessEnvelope: envelope }, current, NOW)).toMatchObject({
      lane: 'implementation',
      likelyStale: false,
      score: 1,
    });
  });

  it('routes a moved source/runtime generation to cheap validation, never a terminal verdict', () => {
    const envelope = createBugFreshnessEnvelope({
      now: '2026-08-10T19:00:00.000Z',
      sourceSha: 'old1111',
      runtimeSha: 'old1111',
      reporterSession: 'su-a',
    });
    const verdict = assessClaimFreshness({ freshnessEnvelope: envelope }, current, NOW);
    expect(verdict).toMatchObject({ lane: 'validation', likelyStale: true });
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'source HEAD moved since observation',
      'runtime/deploy generation moved since observation',
    ]));
    expect(verdict.instruction).toContain('never auto-closes');
  });

  it('routes pre-envelope legacy bugs through validation instead of guessing or closing', () => {
    expect(assessClaimFreshness({}, current, NOW)).toMatchObject({
      lane: 'validation',
      score: 0.2,
      reasons: ['no freshness envelope (pre-envelope or unknown-generation report)'],
    });
  });

  it('linked fixing work forces validation even when the generation matches', () => {
    const envelope = createBugFreshnessEnvelope({
      now: '2026-08-11T19:00:00.000Z',
      sourceSha: 'abc1234',
      runtimeSha: 'abc1234',
      lastSuccessfulReproductionAt: '2026-08-11T19:30:00.000Z',
      linkedFixRefs: ['WI-42'],
    });
    expect(assessClaimFreshness({ freshnessEnvelope: envelope }, current, NOW)).toMatchObject({
      lane: 'validation',
      likelyStale: true,
    });
  });
});
