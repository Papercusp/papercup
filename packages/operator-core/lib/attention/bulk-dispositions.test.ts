import { describe, expect, it } from 'vitest';
import {
  BULK_CONFIDENCE_LEVELS,
  BULK_DISPOSITION_KINDS,
  DEFAULT_BULK_AUTOMATION_POLICY,
  canonicalDispositionForRow,
  classifyLegacySkipped,
  countBulkDispositions,
  bulkAutomationEligibility,
  isBulkConfidence,
  meetsBulkConfidenceFloor,
  normalizeBulkAutomationPolicy,
  isBulkDispositionKind,
  isBulkRecommendationKind,
  BULK_INTAKE_DISPOSITIONS,
  BULK_INTAKE_DISPOSITION_OFFER,
  BULK_RECOMMENDATION_KINDS,
  intakeRecommendationFor,
  isIntakeAttentionKind,
  parseIntakeDecision,
  readIntakeDecision,
} from './bulk-dispositions';

// observation-candidate-acceptance-promotion-2026-09-30 P-004 (R-3/R-18/R-19).
describe('intake dispositions', () => {
  const ctx = { decidedBy: 'su-resolver', now: new Date('2026-10-01T10:00:00Z') };

  it('offers exactly six dispositions, each requiring a reason, merge a target and retry the missing information', () => {
    expect([...BULK_INTAKE_DISPOSITIONS]).toEqual(['promote', 'merge', 'investigate', 'retain', 'reject', 'retry']);
    expect(BULK_INTAKE_DISPOSITION_OFFER.map((o) => o.disposition)).toEqual([...BULK_INTAKE_DISPOSITIONS]);
    for (const offer of BULK_INTAKE_DISPOSITION_OFFER) expect(offer.requires).toContain('reason');
    expect(BULK_INTAKE_DISPOSITION_OFFER.find((o) => o.disposition === 'merge')!.requires).toContain('targetRef');
    expect(BULK_INTAKE_DISPOSITION_OFFER.find((o) => o.disposition === 'retry')!.requires).toContain(
      'missingInformation',
    );
    expect(isIntakeAttentionKind('improvement')).toBe(true);
    expect(isIntakeAttentionKind('coord-message')).toBe(false);
    expect(isIntakeAttentionKind(null)).toBe(false);
  });

  it('refuses rather than defaults: unknown disposition, blank reason, no decider, merge without target, retry without missing info', () => {
    expect(parseIntakeDecision({ disposition: 'ignore', reason: 'x' }, ctx)).toMatchObject({ ok: false });
    expect(parseIntakeDecision({ disposition: 'reject', reason: '   ' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining('reason'),
    });
    expect(parseIntakeDecision({ disposition: 'reject', reason: 'dup' }, { decidedBy: ' ' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('attributable'),
    });
    expect(parseIntakeDecision({ disposition: 'merge', reason: 'same' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining('targetRef'),
    });
    expect(parseIntakeDecision({ disposition: 'retry', reason: 'unclear' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining('missingInformation'),
    });
  });

  it('records an attributable decision with a per-disposition default owner', () => {
    const parsed = parseIntakeDecision({ disposition: 'merge', reason: ' same cause ', targetRef: 'WI-9' }, ctx);
    expect(parsed).toEqual({
      ok: true,
      decision: {
        disposition: 'merge',
        reason: 'same cause',
        decidedBy: 'su-resolver',
        owner: 'agent',
        targetRef: 'WI-9',
        missingInformation: null,
        decidedAt: '2026-10-01T10:00:00.000Z',
        workKind: null,
        acceptance: null,
        sourceRevision: null,
      },
    });
    const owned = parseIntakeDecision({ disposition: 'promote', reason: 'real', owner: 'owner' }, ctx);
    expect(owned.ok && owned.decision.owner).toBe('owner');
  });

  // P-006 (D-014): the decision carries the kind, a drafted acceptance proposal and
  // the judged source revision — each scoped to the dispositions that execute it.
  it('binds workKind to promote, acceptance to promote/investigate, and stamps the judged source revision', () => {
    const promote = parseIntakeDecision(
      {
        disposition: 'promote',
        reason: 'real defect',
        workKind: 'fix',
        acceptance: { problem: ' p ', evidence: [' e1 ', '', '  '], outcome: 'o', scope: '', completionCheck: 'c' },
      },
      { ...ctx, sourceRevision: ' sha256:abc ' },
    );
    expect(promote).toMatchObject({
      ok: true,
      decision: {
        workKind: 'fix',
        acceptance: { problem: 'p', evidence: ['e1'], outcome: 'o', completionCheck: 'c' },
        sourceRevision: 'sha256:abc',
      },
    });
    expect(promote.ok && 'scope' in (promote.decision.acceptance ?? {})).toBe(false);

    const investigate = parseIntakeDecision(
      { disposition: 'investigate', reason: 'unclear cause', acceptance: { problem: 'p' } },
      ctx,
    );
    expect(investigate).toMatchObject({ ok: true, decision: { acceptance: { problem: 'p' }, workKind: null } });

    expect(parseIntakeDecision({ disposition: 'investigate', reason: 'r', workKind: 'fix' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining('promote only'),
    });
    expect(parseIntakeDecision({ disposition: 'promote', reason: 'r', workKind: 'feature' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining('workKind must be one of'),
    });
    expect(
      parseIntakeDecision({ disposition: 'reject', reason: 'r', acceptance: { problem: 'p' } }, ctx),
    ).toMatchObject({ ok: false, error: expect.stringContaining('promote/investigate only') });
    // An all-blank proposal is no proposal, so it never refuses an otherwise valid decision.
    expect(
      parseIntakeDecision({ disposition: 'reject', reason: 'r', acceptance: { problem: '  ', evidence: [''] } }, ctx),
    ).toMatchObject({ ok: true, decision: { acceptance: null } });
  });

  it('projects every disposition onto the existing CHECK-constrained recommendation vocabulary', () => {
    for (const disposition of BULK_INTAKE_DISPOSITIONS) {
      const parsed = parseIntakeDecision(
        { disposition, reason: 'r', targetRef: 'WI-1', missingInformation: 'the run id' },
        ctx,
      );
      if (!parsed.ok) throw new Error(parsed.error);
      const projected = intakeRecommendationFor(parsed.decision);
      expect(BULK_RECOMMENDATION_KINDS).toContain(projected.recommendationKind);
      expect(BULK_DISPOSITION_KINDS).toContain(projected.disposition);
      expect(projected.retryCondition).toBe(disposition === 'retry' ? 'the run id' : null);
    }
  });

  it('reads persisted decisions tolerantly and drops malformed ones', () => {
    const stored = {
      disposition: 'reject',
      reason: 'dup',
      decidedBy: 'su-a',
      owner: 'system',
      targetRef: null,
      missingInformation: null,
      decidedAt: '2026-10-01T10:00:00.000Z',
      workKind: null,
      acceptance: null,
      sourceRevision: null,
    };
    expect(readIntakeDecision(stored)).toEqual(stored);
    expect(readIntakeDecision(JSON.stringify(stored))).toEqual(stored);
    // A row written before P-006 has none of the execution fields; it reads as null, not as a refusal.
    const { workKind: _w, acceptance: _a, sourceRevision: _s, ...preP006 } = stored;
    expect(readIntakeDecision(preP006)).toEqual(stored);
    expect(readIntakeDecision({ ...stored, workKind: 'feature' })).toEqual(stored);
    expect(
      readIntakeDecision({ ...stored, disposition: 'promote', workKind: 'build', sourceRevision: 'rev-1' }),
    ).toMatchObject({ workKind: 'build', sourceRevision: 'rev-1' });
    expect(readIntakeDecision(null)).toBeNull();
    expect(readIntakeDecision('{not json')).toBeNull();
    expect(readIntakeDecision({ ...stored, reason: '' })).toBeNull();
    expect(readIntakeDecision({ ...stored, disposition: 'ignore' })).toBeNull();
  });
});

describe('bulk disposition vocabulary', () => {
  it('exposes four confidence levels and runtime guards', () => {
    expect(BULK_CONFIDENCE_LEVELS).toEqual(['high', 'medium', 'low', 'insufficient']);
    expect(isBulkConfidence('high')).toBe(true);
    expect(isBulkConfidence('medium')).toBe(true);
    expect(isBulkConfidence('low')).toBe(true);
    expect(isBulkConfidence('insufficient')).toBe(true);
    expect(isBulkConfidence('provable')).toBe(false);
    expect(isBulkRecommendationKind('owner_action')).toBe(true);
    expect(isBulkRecommendationKind('skipped')).toBe(false);
    expect(isBulkDispositionKind('legacy_skipped')).toBe(true);
    expect(isBulkDispositionKind('not-a-disposition')).toBe(false);
  });

  it('normalizes owner automation modes without letting confidence bypass review-all', () => {
    expect(DEFAULT_BULK_AUTOMATION_POLICY).toEqual({ mode: 'safe-high', minConfidence: 'high' });
    expect(normalizeBulkAutomationPolicy({ mode: 'review-all', minConfidence: 'low' })).toEqual({
      mode: 'review-all',
      minConfidence: 'high',
    });
    expect(normalizeBulkAutomationPolicy({ mode: 'safe-medium-plus', minConfidence: 'medium' })).toEqual({
      mode: 'safe-medium-plus',
      minConfidence: 'medium',
    });
    expect(meetsBulkConfidenceFloor('high', 'medium')).toBe(true);
    expect(meetsBulkConfidenceFloor('low', 'medium')).toBe(false);
    expect(meetsBulkConfidenceFloor('insufficient', 'high')).toBe(false);
    expect(
      bulkAutomationEligibility({ mode: 'review-all', minConfidence: 'high' }, 'high'),
    ).toEqual({ allowed: false, reason: 'review-all' });
    expect(
      bulkAutomationEligibility({ mode: 'safe-high', minConfidence: 'high' }, 'medium'),
    ).toEqual({ allowed: false, reason: 'confidence-below-floor' });
    expect(
      bulkAutomationEligibility({ mode: 'safe-medium-plus', minConfidence: 'medium' }, 'medium'),
    ).toEqual({ allowed: true, reason: null });
  });

  it('classifies owner-authority rows without inventing an action id', () => {
    const result = classifyLegacySkipped({
      itemKind: 'dark-flag-ratification',
      error: 'Dark-flag ratification is owner-authority by definition',
      itemId: 'flag-1',
    });
    expect(result).toMatchObject({
      disposition: 'owner_action',
      reasonCode: 'owner-authority',
      recommendation: {
        kind: 'owner_action',
        confidence: 'high',
        responsibility: 'owner',
        actionId: null,
      },
    });
  });

  it('classifies stale, duplicate, and already-done rows as cleanup candidates', () => {
    const result = classifyLegacySkipped({
      itemKind: 'plan-item',
      error: 'Moot: item already done; stale feed row offering no actions',
    });
    expect(result.disposition).toBe('cleanup_candidate');
    expect(result.reasonCode).toBe('stale-duplicate-or-moot');
    expect(result.recommendation.confidence).toBe('high');
  });

  it('classifies unavailable detail as retry-needed, not owner work', () => {
    const result = classifyLegacySkipped({
      itemKind: 'work-item-needs-human',
      error: 'No options offered (detail not loaded or item left the feed)',
    });
    expect(result.disposition).toBe('retry_needed');
    expect(result.reasonCode).toBe('retry-data-unavailable');
    expect(result.recommendation.confidence).toBe('insufficient');
    expect(result.recommendation.retryCondition).toContain('Reload');
  });

  it('routes engineering defects instead of presenting them as owner decisions', () => {
    const result = classifyLegacySkipped({
      itemKind: 'coord-escalation',
      error: 'Real defect report (claude self-re-exec severs psu session); engineering work',
    });
    expect(result.disposition).toBe('routed');
    expect(result.reasonCode).toBe('engineering-route');
    expect(result.recommendation.responsibility).toBe('engineering');
  });

  it('makes ambiguous open/discuss-only rows explicit investigations', () => {
    const result = classifyLegacySkipped({
      itemKind: 'work-item-needs-human',
      error: 'No terminal option offered (open/discuss are both non-terminal)',
    });
    expect(result.disposition).toBe('investigate');
    expect(result.reasonCode).toBe('owner-investigation');
    expect(result.recommendation.confidence).toBe('insufficient');
    expect(result.recommendation.actionId).toBeNull();
  });

  it('maps legacy rows and conserves every row in canonical accounting', () => {
    const rows = [
      { outcome: 'auto_resolved' },
      { outcome: 'recommended' },
      { outcome: 'pending' },
      { outcome: 'failed' },
      { outcome: 'dismissed' },
      { outcome: 'skipped', itemKind: 'dark-flag-ratification', error: 'owner authority' },
      { outcome: 'skipped', itemKind: 'plan-item', error: 'Moot: already done' },
      { outcome: 'skipped', itemKind: 'work-item-needs-human', error: 'detail not loaded; no options offered' },
      { outcome: 'skipped', itemKind: 'coord-escalation', error: 'Real defect report; engineering work' },
      { outcome: 'skipped', itemKind: 'work-item-needs-human', error: 'No terminal option offered' },
    ] as const;
    const counts = countBulkDispositions(rows);
    expect(counts.total).toBe(10);
    expect(counts.autoResolved).toBe(1);
    expect(counts.recommended).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.dismissed).toBe(1);
    expect(counts.ownerAction).toBe(1);
    expect(counts.cleanupCandidate).toBe(1);
    expect(counts.retryNeeded).toBe(1);
    expect(counts.routed).toBe(1);
    expect(counts.investigate).toBe(1);
    expect(
      counts.autoResolved +
        counts.recommended +
        counts.pending +
        counts.ownerAction +
        counts.cleanupCandidate +
        counts.retryNeeded +
        counts.routed +
        counts.investigate +
        counts.failed +
        counts.dismissed,
    ).toBe(counts.total);
    expect(counts.unresolved).toBe(8);
  });

  it('never treats an unknown outcome as terminal', () => {
    const record = canonicalDispositionForRow({ outcome: 'future-value' });
    expect(record.disposition).toBe('investigate');
    expect(record.recommendation?.confidence).toBe('insufficient');
    expect(BULK_DISPOSITION_KINDS).toContain(record.disposition);
  });
});
