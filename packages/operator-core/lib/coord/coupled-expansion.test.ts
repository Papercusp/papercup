/**
 * coupled-expansion.test.ts — P-031 leg (d), the union consumer.
 *
 * The properties that matter here are the ones a later edit is most likely to
 * break silently: the base payload never varies (D-053), a coupled peer outside
 * the read's scope is DISCLOSED as out-of-scope rather than dropped or
 * back-filled (D-044 — relevance, never access), and no field is ever named
 * `goal` while P-016 is unbuilt.
 */
import { describe, it, expect } from 'vitest';
import type { CoupledPeer } from './couplings';
import {
  buildCoupledExpansion,
  expandedBecauseOf,
  COUPLED_EXPANSION_MAX,
  type CoupledExpansionEntry,
} from './coupled-expansion';

const row = (o: Partial<Record<string, unknown>> & { ownerId: string }) => ({
  ownerLabel: `label-${o.ownerId}`,
  sessionState: 'live',
  intent: `doing ${o.ownerId} things`,
  intentStale: false,
  lastActiveSecAgo: 12,
  ...o,
});

const declared = (ownerId: string, extra?: Partial<CoupledPeer>): CoupledPeer => ({
  ownerId,
  source: 'declared',
  reason: 'both editing sync-resolver',
  declaredBy: 'su-third',
  ...extra,
});

describe('buildCoupledExpansion', () => {
  it('projects a coupled peer from the roster row the caller already has', () => {
    const { expanded, total, truncated } = buildCoupledExpansion(
      [declared('su-b')],
      [row({ ownerId: 'su-a' }), row({ ownerId: 'su-b' })],
    );
    expect(total).toBe(1);
    expect(truncated).toBe(false);
    expect(expanded).toEqual([
      {
        ownerId: 'su-b',
        expandedBecause: 'coupled — declared by su-third: both editing sync-resolver',
        source: 'declared',
        reason: 'both editing sync-resolver',
        declaredBy: 'su-third',
        inRoster: true,
        ownerLabel: 'label-su-b',
        sessionState: 'live',
        intent: 'doing su-b things',
        intentStale: false,
        lastActiveSecAgo: 12,
      } satisfies CoupledExpansionEntry,
    ]);
  });

  it('DISCLOSES an out-of-scope coupled peer as inRoster:false with null state — never drops it, never back-fills it', () => {
    // The third-party couple case: `su-elsewhere` is coupled but lives in another
    // hive, so this read's roster does not contain it. Dropping it would read as a
    // broken tool ("I coupled them and nothing happened"); inventing state for it
    // would turn a RELEVANCE gate into an ACCESS grant.
    const { expanded } = buildCoupledExpansion([declared('su-elsewhere')], [row({ ownerId: 'su-a' })]);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({
      ownerId: 'su-elsewhere',
      inRoster: false,
      ownerLabel: null,
      sessionState: null,
      intent: null,
      intentStale: null,
      lastActiveSecAgo: null,
    });
    // Still explains itself — the coupling is the point, the state is the bonus.
    expect(expanded[0].expandedBecause).toContain('declared by su-third');
  });

  it('does not mutate or reorder the roster rows it reads (D-053: the base payload never varies)', () => {
    const rows = [row({ ownerId: 'su-a' }), row({ ownerId: 'su-b' })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    buildCoupledExpansion([declared('su-b')], rows);
    expect(rows).toEqual(snapshot);
  });

  it('carries declaredBy/reason ONLY for a declared edge, so the union halves stay distinguishable', () => {
    const { expanded } = buildCoupledExpansion(
      [
        { ownerId: 'su-b', source: 'derived' },
        declared('su-c'),
        { ownerId: 'su-d', source: 'both', reason: 'paired', declaredBy: 'su-me' },
      ],
      [row({ ownerId: 'su-b' }), row({ ownerId: 'su-c' }), row({ ownerId: 'su-d' })],
    );
    expect(expanded[0]).not.toHaveProperty('declaredBy');
    expect(expanded[0]).not.toHaveProperty('reason');
    expect(expanded[1]).toMatchObject({ declaredBy: 'su-third', reason: 'both editing sync-resolver' });
    expect(expanded[2]).toMatchObject({ source: 'both', declaredBy: 'su-me', reason: 'paired' });
  });

  it('emits reason:null (not an omitted key) for a declared edge with no stated reason', () => {
    const { expanded } = buildCoupledExpansion(
      [declared('su-b', { reason: null })],
      [row({ ownerId: 'su-b' })],
    );
    expect(expanded[0].reason).toBeNull();
    expect(expanded[0].expandedBecause).toBe('coupled — declared by su-third');
  });

  it('caps the block and reports the cut rather than truncating silently', () => {
    const peers = Array.from({ length: COUPLED_EXPANSION_MAX + 5 }, (_, i) =>
      declared(`su-${String(i).padStart(3, '0')}`),
    );
    const { expanded, total, truncated } = buildCoupledExpansion(peers, []);
    expect(expanded).toHaveLength(COUPLED_EXPANSION_MAX);
    expect(total).toBe(COUPLED_EXPANSION_MAX + 5);
    expect(truncated).toBe(true);
  });

  it('honours an explicit max', () => {
    const peers = [declared('su-a'), declared('su-b'), declared('su-c')];
    const { expanded, total, truncated } = buildCoupledExpansion(peers, [], { max: 2 });
    expect(expanded.map((e) => e.ownerId)).toEqual(['su-a', 'su-b']);
    expect(total).toBe(3);
    expect(truncated).toBe(true);
  });

  it('is total on junk input — a malformed row degrades to nulls, never a throw', () => {
    const { expanded } = buildCoupledExpansion(
      [declared('su-b')],
      [null, undefined, 42, { ownerId: 'su-b', intent: 99, intentStale: 'yes', lastActiveSecAgo: NaN }],
    );
    expect(expanded[0]).toMatchObject({
      inRoster: true,
      intent: null,
      intentStale: null,
      lastActiveSecAgo: null,
    });
  });

  it('returns an empty block for no coupled peers', () => {
    expect(buildCoupledExpansion([], [row({ ownerId: 'su-a' })])).toEqual({
      expanded: [],
      total: 0,
      truncated: false,
    });
  });

  it('takes the FIRST roster row for a duplicated ownerId (deterministic, no last-write-wins)', () => {
    const { expanded } = buildCoupledExpansion(
      [declared('su-b')],
      [row({ ownerId: 'su-b', intent: 'first' }), row({ ownerId: 'su-b', intent: 'second' })],
    );
    expect(expanded[0].intent).toBe('first');
  });

  it('⚠ names NO field `goal` while P-016 is unbuilt — a declared intent is not a goal', () => {
    // P-029's lesson, pinned: a populated field is not a meaningful field. The only
    // per-peer text available today is coord_presence.intent, and calling it a goal
    // would report every live agent as having declared one.
    const { expanded } = buildCoupledExpansion([declared('su-b')], [row({ ownerId: 'su-b' })]);
    const keys = Object.keys(expanded[0]);
    expect(keys).not.toContain('goal');
    expect(keys).not.toContain('goalText');
    expect(keys).not.toContain('assumptions');
    // The key set is pinned so a reader-relative or fabricated field cannot be
    // added silently (the claim-holder.test.ts precedent).
    expect(keys.sort()).toEqual(
      [
        'declaredBy',
        'expandedBecause',
        'inRoster',
        'intent',
        'intentStale',
        'lastActiveSecAgo',
        'ownerId',
        'ownerLabel',
        'reason',
        'sessionState',
        'source',
      ].sort(),
    );
  });
});

describe('expandedBecauseOf', () => {
  it('explains every source, and a declared edge with no reason still names its author', () => {
    expect(expandedBecauseOf({ ownerId: 'x', source: 'derived' })).toBe(
      'coupled — derived from shared working state',
    );
    expect(expandedBecauseOf({ ownerId: 'x', source: 'declared', declaredBy: 'su-1' })).toBe(
      'coupled — declared by su-1',
    );
    expect(
      expandedBecauseOf({ ownerId: 'x', source: 'both', declaredBy: 'su-1', reason: 'same file' }),
    ).toBe('coupled — derived, and declared by su-1: same file');
  });

  it('degrades to "an agent" rather than an empty phrase when declaredBy is missing', () => {
    expect(expandedBecauseOf({ ownerId: 'x', source: 'declared' })).toBe('coupled — declared by an agent');
  });
});
