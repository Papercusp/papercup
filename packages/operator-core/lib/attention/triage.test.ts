import { describe, it, expect } from 'vitest';
import {
  needsHumanForTier,
  triageActionToState,
  groupByTier,
  applyTriage,
  untriaged,
  type AttentionItem,
  type TriageRecord,
} from './types';
import { coordMessageToAttention, planReviewToAttention, smokeFailToAttention } from './adapters';

describe('needsHumanForTier', () => {
  it('only the decision tier awaits the human', () => {
    expect(needsHumanForTier('decision')).toBe(true);
    expect(needsHumanForTier('handled')).toBe(false);
    expect(needsHumanForTier('alert')).toBe(false);
    expect(needsHumanForTier('activity')).toBe(false);
  });
});

describe('triageActionToState', () => {
  it('maps each action to its state', () => {
    expect(triageActionToState('confirm')).toBe('confirmed');
    expect(triageActionToState('escalate')).toBe('escalated');
    expect(triageActionToState('downgrade')).toBe('downgraded');
    expect(triageActionToState('resolve')).toBe('resolved');
  });
});

describe('untriaged', () => {
  it('is the untriaged default', () => {
    expect(untriaged()).toEqual({ triageState: 'untriaged', triageNote: null, triagedBy: null, triagedAt: null });
  });
});

describe('applyTriage (D-006)', () => {
  const decisionItem = planReviewToAttention({ harnessSlug: 'h' }); // tier=decision, needsHuman
  const rec = (action: TriageRecord['action']): TriageRecord => ({
    action,
    note: 'because reasons',
    triagedBy: 'system:operator',
    triagedAt: '2026-06-05T00:00:00.000Z',
  });

  it('downgrade → handled tier, not needs-human, audit attached', () => {
    const a = applyTriage(decisionItem, rec('downgrade'));
    expect(a.tier).toBe('handled');
    expect(a.needsHuman).toBe(false);
    expect(a.triageState).toBe('downgraded');
    expect(a.triageNote).toBe('because reasons');
    expect(a.triagedBy).toBe('system:operator');
    expect(a.triagedAt).toBe('2026-06-05T00:00:00.000Z');
  });

  it('resolve → handled tier', () => {
    expect(applyTriage(decisionItem, rec('resolve')).tier).toBe('handled');
  });

  it('confirm → stays decision, marked confirmed', () => {
    const a = applyTriage(decisionItem, rec('confirm'));
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.triageState).toBe('confirmed');
  });

  it('escalate → promotes an alert to decision', () => {
    const alert = smokeFailToAttention({ harnessSlug: 'h' }); // tier=alert
    const a = applyTriage(alert, rec('escalate'));
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.triageState).toBe('escalated');
  });
});

describe('groupByTier', () => {
  it('partitions into four importance-sorted buckets with counts', () => {
    const items: AttentionItem[] = [
      planReviewToAttention({ harnessSlug: 'h' }), // decision
      smokeFailToAttention({ harnessSlug: 'h' }), // alert
      coordMessageToAttention({ msgId: 'a', summary: 'x', auto: true, lifecycle: 'intent' }), // activity
      applyTriage(planReviewToAttention({ harnessSlug: 'h2' }), {
        action: 'downgrade',
        note: 'dup',
        triagedBy: 'op',
        triagedAt: null,
      }), // handled
    ];
    const t = groupByTier(items);
    expect(t.counts).toEqual({ decision: 1, handled: 1, alert: 1, activity: 1 });
    expect(t.decision).toHaveLength(1);
    expect(t.handled[0].triageState).toBe('downgraded');
  });
});
