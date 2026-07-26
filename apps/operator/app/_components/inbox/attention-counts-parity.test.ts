// @vitest-environment node
/**
 * Badge-vs-list parity: the SERVER's attention counts must equal the CLIENT's
 * derivation over the same feed (WI-5955).
 *
 * WHY THIS TEST EXISTS. The badge and the Inbox pane were deliberately derived
 * from ONE client-side list so they could never disagree — use-inbox-pending.ts
 * says so explicitly. WI-5955 moved the badge onto a server-computed aggregate
 * (`plans.attentionCounts`) to stop pulling ~1MB for two integers, which
 * REINTRODUCES the chance the two drift apart. A drift would be near-invisible:
 * a badge reading "3 need you" over a list showing 5, with nothing erroring.
 *
 * So this runs BOTH derivations over the same fixtures and asserts equality:
 *   - server: deriveAttentionCounts / effectiveAttentionTier (operator-core)
 *   - client: effectiveTier + the dedupe in useInboxAttention (this app)
 * Change one without the other and this reds.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveAttentionCounts,
  effectiveAttentionTier,
} from '@papercusp/operator-core/lib/sync-resolver/attention-counts';
import { effectiveTier } from './use-inbox-pending';
import type { AttentionItem } from '@/app/admin/plans/plans-api';

/** The client's own derivation, reproduced from useInboxAttention +
 *  useInboxPendingCount + usePlansNeedingYouCount (dedupe by id, then count). */
function clientCounts(groups: Array<{ items: unknown[] }>) {
  const seen = new Set<string>();
  const items: AttentionItem[] = [];
  for (const g of groups) {
    for (const it of g.items) {
      const item = it as AttentionItem;
      if (!item || typeof item !== 'object' || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  const decisions = items.filter((i) => effectiveTier(i) === 'decision');
  const plans = new Set<string>();
  for (const i of decisions) if (i.planSlug) plans.add(i.planSlug);
  return {
    decisionItems: decisions.length,
    decisionPlans: plans.size,
    alerts: items.filter((i) => effectiveTier(i) === 'alert').length,
    total: items.length,
  };
}

const item = (over: Record<string, unknown>) => ({ kind: 'coord-message', ...over });

/** Each fixture is a whole grouped feed, exercising one hazard. */
const FIXTURES: Record<string, Array<{ items: unknown[] }>> = {
  'plain mix of tiers': [
    {
      items: [
        item({ id: 'd1', tier: 'decision', planSlug: 'alpha' }),
        item({ id: 'a1', tier: 'alert' }),
        item({ id: 'x1', tier: 'activity' }),
        item({ id: 'h1', tier: 'handled' }),
      ],
    },
  ],
  // The WI-5337 hazard: a non-plan-scoped item is emitted into EVERY plan group.
  'same item duplicated across groups': [
    { items: [item({ id: 'wall', tier: 'decision' }), item({ id: 'd1', tier: 'decision', planSlug: 'alpha' })] },
    { items: [item({ id: 'wall', tier: 'decision' }), item({ id: 'd2', tier: 'decision', planSlug: 'beta' })] },
    { items: [item({ id: 'wall', tier: 'decision' })] },
  ],
  // Wire-lag: a pre-tier server sends no `tier` and both sides must infer it.
  'tier absent — needsHuman fallback': [
    { items: [item({ id: 'n1', needsHuman: true, planSlug: 'alpha' }), item({ id: 'n2', needsHuman: false })] },
  ],
  'tier absent — kind fallback to alert': [
    {
      items: [
        item({ id: 's1', kind: 'smoke-fail' }),
        item({ id: 'e1', kind: 'coord-escalation' }),
        item({ id: 'c1', kind: 'coord-message' }),
      ],
    },
  ],
  'decisions sharing one plan count as ONE plan': [
    {
      items: [
        item({ id: 'd1', tier: 'decision', planSlug: 'alpha' }),
        item({ id: 'd2', tier: 'decision', planSlug: 'alpha' }),
        item({ id: 'd3', tier: 'decision', planSlug: 'beta' }),
      ],
    },
  ],
  'decisions with no plan contribute items but no plan': [
    {
      items: [
        item({ id: 'd1', tier: 'decision' }),
        item({ id: 'd2', tier: 'decision', planSlug: null }),
        item({ id: 'd3', tier: 'decision', planSlug: 'alpha' }),
      ],
    },
  ],
  'empty feed': [],
  'groups with no items': [{ items: [] }, { items: [] }],
};

describe('server counts == client derivation', () => {
  for (const [name, groups] of Object.entries(FIXTURES)) {
    it(name, () => {
      expect(deriveAttentionCounts(groups)).toEqual(clientCounts(groups));
    });
  }
});

describe('effectiveTier parity (the fallback is the drift-prone part)', () => {
  const CASES: Array<Record<string, unknown>> = [
    { id: 'a', tier: 'decision' },
    { id: 'b', tier: 'alert' },
    { id: 'c', tier: 'activity' },
    { id: 'd', tier: 'handled' },
    { id: 'e', needsHuman: true },
    { id: 'f', needsHuman: false, kind: 'smoke-fail' },
    { id: 'g', kind: 'coord-escalation' },
    { id: 'h', kind: 'coord-message' },
    { id: 'i', kind: 'plan-item' },
    // tier wins over the fallbacks when both are present
    { id: 'j', tier: 'activity', needsHuman: true },
  ];
  for (const c of CASES) {
    it(`agrees for ${JSON.stringify(c)}`, () => {
      expect(effectiveAttentionTier(c)).toBe(effectiveTier(c as unknown as AttentionItem));
    });
  }
});

describe('deriveAttentionCounts defensiveness', () => {
  it('skips malformed rows instead of throwing or over-counting', () => {
    const groups = [null, { items: null }, { items: [null, 'raw', { tier: 'decision' }] }];
    // The bare object has no id, so it cannot be deduped and is not counted.
    expect(deriveAttentionCounts(groups)).toEqual({
      decisionItems: 0,
      decisionPlans: 0,
      alerts: 0,
      total: 0,
    });
  });
});
