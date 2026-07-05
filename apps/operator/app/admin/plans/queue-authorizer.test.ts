import { describe, expect, it } from 'vitest';
import { lexiconFor } from '@papercusp/lexicon';
import type { AttentionItem } from './plans-api';
import { byAuthorizer, whyLine } from './queue-authorizer';

// The grouping helpers now take a bound lexicon (restore-pot-lexicon P-007). Use
// the real classic/public pack so the asserted copy matches what flag-off ships:
// t('brain') → "Mug" (owner FINAL cast 2026-07-04, restore-pot-lexicon D-006).
const t = lexiconFor('classic');

/** Minimal AttentionItem for the pure grouping helpers. */
function mk(over: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    kind: 'coord-escalation',
    source: 'coord',
    harnessSlug: null,
    planSlug: null,
    itemRef: null,
    title: 'x',
    body: '',
    status: 'open',
    importance: 'normal',
    tier: 'decision',
    needsHuman: true,
    ownerAgentId: null,
    ownerLabel: null,
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [],
    ref: { kind: 'coord-escalation' },
    ...over,
  } as AttentionItem;
}

describe('byAuthorizer (P-004)', () => {
  it('partitions items into you / queen-eligible / other buckets', () => {
    const sections = byAuthorizer([
      mk({ id: 'a', authorizer: 'you' }),
      mk({ id: 'b', authorizer: 'queen-eligible' }),
      mk({ id: 'c', authorizer: 'queen-eligible' }),
      mk({ id: 'd', authorizer: null }),
    ], t);
    const byKey = Object.fromEntries(sections.map((s) => [s.key, s.items.map((i) => i.id)]));
    expect(byKey['auth:you']).toEqual(['a']);
    expect(byKey['auth:queen']).toEqual(['b', 'c']);
    expect(byKey['auth:other']).toEqual(['d']);
  });

  it('drops empty buckets', () => {
    const sections = byAuthorizer([mk({ id: 'a', authorizer: 'you' })], t);
    expect(sections.map((s) => s.key)).toEqual(['auth:you']);
  });

  it('flags the queen-eligible bucket for the autonomy deep-link', () => {
    const [s] = byAuthorizer([mk({ id: 'b', authorizer: 'queen-eligible' })], t);
    expect(s.queenLink).toBe(true);
    expect(s.title).toBe('Automatable — for now');
  });
});

describe('whyLine (P-005)', () => {
  it('is null for non-decisions (no authorizer)', () => {
    expect(whyLine(mk({ id: 'a', authorizer: null }), t)).toBeNull();
  });

  it('routes "you" items with their reason', () => {
    expect(whyLine(mk({ id: 'a', authorizer: 'you', whyGated: 'protected' }), t)).toBe(
      'needs you · protected category — your call by right',
    );
    expect(whyLine(mk({ id: 'b', authorizer: 'you', whyGated: 'owner-only' }), t)).toBe(
      'needs you · your ratification',
    );
  });

  it('routes queen-eligible items with their reason', () => {
    // Copy routes through the bound lexicon (restore-pot-lexicon P-007) — assert
    // the SAME routed key, never a hardcoded cast name (t('brain') → "Mug" under
    // the classic/public pack; the-hive pack renders "Brain").
    expect(whyLine(mk({ id: 'c', authorizer: 'queen-eligible', whyGated: 'unarmed' }), t)).toBe(
      `the ${t('brain')} could take this · the ${t('brain')} isn't armed yet`,
    );
    expect(whyLine(mk({ id: 'd', authorizer: 'queen-eligible', whyGated: 'above-ceiling' }), t)).toBe(
      `the ${t('brain')} could take this · above the ${t('brain')}'s autonomy ceiling`,
    );
  });

  it('falls back to who-only when whyGated is absent', () => {
    expect(whyLine(mk({ id: 'e', authorizer: 'you' }), t)).toBe('needs you');
  });
});
