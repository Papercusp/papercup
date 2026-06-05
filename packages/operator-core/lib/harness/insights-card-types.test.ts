import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_EVENT_KINDS,
  ACTIVITY_EVENT_TIER,
  ACTIVITY_FEED_DEFAULT_LIMIT,
  INSIGHTS_CARDS,
  buildActivityFeedCardData,
  canRenderInsightsHonestly,
  isViewerContextualCard,
  partitionPeopleByVerification,
  visibleCardsForHarnessState,
  type ActivityEvent,
  type PersonRow,
} from './insights-card-types';

describe('constants', () => {
  it('INSIGHTS_CARDS has 6 in v5 §9.0 order', () => {
    expect([...INSIGHTS_CARDS]).toEqual([
      'project',
      'activity_feed',
      'people',
      'your_place',
      'how_it_works',
      'spend',
    ]);
  });

  it('ACTIVITY_EVENT_KINDS has 5', () => {
    expect(ACTIVITY_EVENT_KINDS.length).toBe(5);
  });

  it('ACTIVITY_EVENT_TIER mapping matches §9.0 spec', () => {
    expect(ACTIVITY_EVENT_TIER.feature_shipped).toBe('B');
    expect(ACTIVITY_EVENT_TIER.pr_merged).toBe('A');
    expect(ACTIVITY_EVENT_TIER.contributor_joined).toBe('C');
    expect(ACTIVITY_EVENT_TIER.decision_added).toBe('C');
    expect(ACTIVITY_EVENT_TIER.escalation_opened).toBe('C');
  });

  it('ACTIVITY_FEED_DEFAULT_LIMIT is 20 per §9.0', () => {
    expect(ACTIVITY_FEED_DEFAULT_LIMIT).toBe(20);
  });
});

describe('buildActivityFeedCardData', () => {
  function makeEvent(over: Partial<ActivityEvent> = {}): ActivityEvent {
    return {
      kind: 'feature_shipped',
      ts: 1716_000_000_000,
      label: 'F-1 shipped',
      detail_url: '/x',
      ...over,
    };
  }

  it('sorts newest-first', () => {
    const data = buildActivityFeedCardData([
      makeEvent({ ts: 100, label: 'old' }),
      makeEvent({ ts: 300, label: 'newest' }),
      makeEvent({ ts: 200, label: 'middle' }),
    ]);
    expect(data.events.map((e) => e.label)).toEqual(['newest', 'middle', 'old']);
  });

  it('respects default limit (20)', () => {
    const many = Array.from({ length: 50 }, (_, i) => makeEvent({ ts: i, label: 'e' + i }));
    expect(buildActivityFeedCardData(many).events.length).toBe(20);
  });

  it('respects custom limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => makeEvent({ ts: i, label: 'e' + i }));
    expect(buildActivityFeedCardData(many, 5).events.length).toBe(5);
  });

  it('returns empty array for empty input', () => {
    expect(buildActivityFeedCardData([]).events).toEqual([]);
  });

  it('clamps negative limit to 0', () => {
    expect(buildActivityFeedCardData([makeEvent()], -1).events).toEqual([]);
  });
});

describe('partitionPeopleByVerification', () => {
  function p(github_user_id: number, binding_status: PersonRow['binding_status']): PersonRow {
    return { github_user_id, github_login: 'u' + github_user_id, avatar_url: null, binding_status };
  }

  it('splits verified vs unverified+pending', () => {
    const out = partitionPeopleByVerification([
      p(1, 'verified'),
      p(2, 'pending'),
      p(3, 'unverified'),
      p(4, 'verified'),
    ]);
    expect(out.verified.map((x) => x.github_user_id)).toEqual([1, 4]);
    expect(out.unverified.map((x) => x.github_user_id)).toEqual([2, 3]);
  });

  it('returns empty arrays for empty input', () => {
    expect(partitionPeopleByVerification([])).toEqual({ verified: [], unverified: [] });
  });
});

describe('visibleCardsForHarnessState', () => {
  it('private state shows reduced set', () => {
    expect(visibleCardsForHarnessState('private')).toEqual([
      'project',
      'how_it_works',
      'spend',
    ]);
  });

  it('shared states show all 6', () => {
    expect(visibleCardsForHarnessState('shared-private').length).toBe(6);
    expect(visibleCardsForHarnessState('shared-public').length).toBe(6);
  });
});

describe('isViewerContextualCard', () => {
  it('your_place + spend are viewer-contextual', () => {
    expect(isViewerContextualCard('your_place')).toBe(true);
    expect(isViewerContextualCard('spend')).toBe(true);
  });

  it('other cards are not viewer-contextual', () => {
    expect(isViewerContextualCard('project')).toBe(false);
    expect(isViewerContextualCard('activity_feed')).toBe(false);
    expect(isViewerContextualCard('people')).toBe(false);
    expect(isViewerContextualCard('how_it_works')).toBe(false);
  });
});

describe('canRenderInsightsHonestly', () => {
  it('true when both deps ready', () => {
    expect(canRenderInsightsHonestly({ usage_ledger_ready: true, binding_verifier_ready: true })).toBe(true);
  });

  it('false when either dep missing', () => {
    expect(canRenderInsightsHonestly({ usage_ledger_ready: true, binding_verifier_ready: false })).toBe(false);
    expect(canRenderInsightsHonestly({ usage_ledger_ready: false, binding_verifier_ready: true })).toBe(false);
    expect(canRenderInsightsHonestly({ usage_ledger_ready: false, binding_verifier_ready: false })).toBe(false);
  });
});
