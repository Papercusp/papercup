import { describe, expect, it } from 'vitest';
import type { AttentionItem } from './plans-api';
import { byAuthorizer, whyLine } from './queue-authorizer';

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
    ]);
    const byKey = Object.fromEntries(sections.map((s) => [s.key, s.items.map((i) => i.id)]));
    expect(byKey['auth:you']).toEqual(['a']);
    expect(byKey['auth:queen']).toEqual(['b', 'c']);
    expect(byKey['auth:other']).toEqual(['d']);
  });

  it('drops empty buckets', () => {
    const sections = byAuthorizer([mk({ id: 'a', authorizer: 'you' })]);
    expect(sections.map((s) => s.key)).toEqual(['auth:you']);
  });

  it('flags the queen-eligible bucket for the autonomy deep-link', () => {
    const [s] = byAuthorizer([mk({ id: 'b', authorizer: 'queen-eligible' })]);
    expect(s.queenLink).toBe(true);
    expect(s.title).toBe('Automatable — for now');
  });
});

describe('whyLine (P-005)', () => {
  it('is null for non-decisions (no authorizer)', () => {
    expect(whyLine(mk({ id: 'a', authorizer: null }))).toBeNull();
  });

  it('routes "you" items with their reason', () => {
    expect(whyLine(mk({ id: 'a', authorizer: 'you', whyGated: 'protected' }))).toBe(
      'needs you · protected category — your call by right',
    );
    expect(whyLine(mk({ id: 'b', authorizer: 'you', whyGated: 'owner-only' }))).toBe(
      'needs you · your ratification',
    );
  });

  it('routes queen-eligible items with their reason', () => {
    expect(whyLine(mk({ id: 'c', authorizer: 'queen-eligible', whyGated: 'unarmed' }))).toBe(
      'the Queen could take this · the Queen isn’t armed yet',
    );
    expect(whyLine(mk({ id: 'd', authorizer: 'queen-eligible', whyGated: 'above-ceiling' }))).toBe(
      'the Queen could take this · above the Queen’s autonomy ceiling',
    );
  });

  it('falls back to who-only when whyGated is absent', () => {
    expect(whyLine(mk({ id: 'e', authorizer: 'you' }))).toBe('needs you');
  });
});
