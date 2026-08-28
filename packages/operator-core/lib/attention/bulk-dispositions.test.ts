import { describe, expect, it } from 'vitest';
import {
  BULK_CONFIDENCE_LEVELS,
  BULK_DISPOSITION_KINDS,
  DEFAULT_BULK_AUTOMATION_POLICY,
  canonicalDispositionForRow,
  classifyLegacySkipped,
  countBulkDispositions,
  isBulkConfidence,
  meetsBulkConfidenceFloor,
  normalizeBulkAutomationPolicy,
  isBulkDispositionKind,
  isBulkRecommendationKind,
} from './bulk-dispositions';

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
