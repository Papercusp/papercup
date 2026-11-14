import { describe, expect, it, vi } from 'vitest';
import { FLEET_PRODUCTIVITY_MAX_MEMBERS, fleetProductivityRescore, measureFleetProductivity,
  rateFleetProductivity, summarizeFleetProductivity, classifyFleetClaimHistory, summarizeFleetClaimHistory,
  FLEET_CLAIM_HISTORY_MAX_ITEMS, type FleetClaimHistoryRow, type FleetProductivityRow } from './execution-productivity';

const window = { workspaceId: 'ws', harnessSlug: 'h', fleet: 'a',
  windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-08T00:00:00Z' };
const row = (owner_id: string, buckets: number, closes: number): FleetProductivityRow =>
  ({ owner_id, buckets, closes, held_items: 0, held_hours: 0 });

describe('fleet productivity literal revision-57 method', () => {
  it('reports fleet and median active-owner rates, named seats, and the per-owner lineage fallback', () => {
    const m = summarizeFleetProductivity(window, [row('a', 40, 5), row('b', 8, 0), row('c', 0, 0)]);
    expect(m.totals).toMatchObject({ closes: 5, activeSeatHours: 12, closesPerActiveSeatHour: 5 / 12,
      medianPerActiveMember: 0.25, eligibleZeroCloseOwners: 2, zeroCloseOwners: 1, zeroCloseShare: 0.5 });
    expect(m.lineage).toMatchObject({ basis: 'owner-id', resolved: false });
    expect(m.members[2]?.closesPerActiveSeatHour).toBeNull();
    expect(rateFleetProductivity(m).rating).toBe('degraded');
  });

  it.each([[80, 'healthy'], [81, 'degraded'], [200, 'degraded'], [201, 'broken']] as const)(
    'uses strict throughput thresholds for %s activity buckets', (buckets, rating) => {
      expect(rateFleetProductivity(summarizeFleetProductivity(window, [row('a', buckets, 5)])).rating)
        .toBe(rating);
    });

  it('does not grade a small, absent, malformed, duplicated, or truncated population as healthy', () => {
    for (const rows of [[], [row('a', 8, 4)], [row('a', -1, 8)], [row('a', 8, 5), row('a', 8, 5)],
      [row('a', 0, 5)], Array.from({ length: FLEET_PRODUCTIVITY_MAX_MEMBERS + 1 }, (_, i) => row(String(i), 8, 5))]) {
      expect(rateFleetProductivity(summarizeFleetProductivity(window, rows)).rating).toBe('unknown');
    }
  });

  it.each([{ ...window, fleet: '*' }, { ...window, workspaceId: '' }, { ...window, windowEnd: window.windowStart },
    { ...window, windowStart: 'invalid' }, { ...window, windowEnd: '2026-10-20T00:00:00Z' }])(
    'refuses invalid scope before any SQL read', async input => {
      const unsafe = vi.fn();
      const result = await measureFleetProductivity(input, { unsafe } as never);
      expect(unsafe).not.toHaveBeenCalled(); expect(result.unavailableReason).toBeTruthy();
    });

  it('requires an actual fleet subject rather than trusting its label', async () => {
    expect(await fleetProductivityRescore().resolve({ ...window, subject: { kind: 'plan', ref: 'a' } }))
      .toMatchObject({ verdict: 'unknown' });
  });

  it.each([[3, 'healthy'], [4, 'degraded'], [5, 'degraded'], [6, 'broken']] as const)(
    'uses the strict zero-close-owner boundary for %s of ten eligible seats', (zero, rating) => {
      const rows = Array.from({ length: 10 }, (_, i) => row(String(i), 8, i < zero ? 0 : 10));
      expect(rateFleetProductivity(summarizeFleetProductivity(window, rows)).rating).toBe(rating);
    });
});

describe('retained claim-history qualification', () => {
  const members = new Set(['a']);
  const event = (owner: string, at: string) => ({ owner, at });
  const before = '2026-09-30T23:00:00Z', claim = '2026-10-01T01:00:00Z';
  const release = '2026-10-01T02:00:00Z', after = '2026-10-08T01:00:00Z';
  const history = (entries: unknown[], holder: string | null = 'a'): FleetClaimHistoryRow =>
    ({ feature_id: 'item', origin: 'local', taken_by: holder, history: entries, history_entries: entries.length });

  it('replays both possible initial phases and computes only conditional window occupancy', () => {
    const r = history([event('other', before), event('a', claim)]);
    expect(classifyFleetClaimHistory(r, window, members)).toEqual({
      classification: 'retained-history-member-held', windowHours: 167 });
    const result = summarizeFleetClaimHistory(window, [r], members);
    expect(result).toMatchObject({ conditionalMemberHeldItems: 1, conditionalMemberHeldWindowHours: 167,
      historicalPopulationVerified: false, terminalStateAtCutoffVerified: false, qualifiesHistoricalTotal: false });
  });

  it('keeps the claim/release ambiguity when later ownership converges after the cutoff', () => {
    const r = history([event('a', claim), event('other', after)], 'other');
    expect(classifyFleetClaimHistory(r, window, members).classification).toBe('cutoff-phase-ambiguous');
  });

  it('recognizes releases and other holders without counting their hours', () => {
    expect(classifyFleetClaimHistory(history([event('other', before), event('a', claim), event('a', release)], null),
      window, members).classification).toBe('retained-history-unheld');
    expect(classifyFleetClaimHistory(history([event('a', before), event('other', claim)], 'other'),
      window, members).classification).toBe('retained-history-other-holder');
  });

  it.each([
    ['remote-history-unqualified', { ...history([event('a', claim)]), origin: 'remote' }],
    ['remote-history-unqualified', { ...history([event('other', before), event('a', claim)]), origin: 'remote:engineer-issues' }],
    ['remote-history-unqualified', { ...history([event('other', before), event('a', claim)]), origin: 'remote:features-by-id' }],
    ['remote-history-unqualified', { ...history([event('other', before), event('a', claim)]), origin: 'remote:future-projection' }],
    ['truncated-history-unqualified', { ...history([event('a', claim)]), history_entries: 1025 }],
    ['malformed-history-unqualified', history([event('a', 'bad-date')])],
    ['malformed-history-unqualified', { ...history([]), history: {} }],
    ['malformed-history-unqualified', history([event('unassigned', claim)])],
    ['nonmonotone-history-unqualified', history([event('a', claim), event('other', before)])],
    ['no-observed-transition-before-cutoff', history([event('a', after)])],
    ['no-observed-transition-before-cutoff', history([])],
    ['current-holder-mismatch-unqualified', history([event('other', before), event('a', claim)], 'missing')],
  ] as const)('reports %s instead of inferring a historical total', (classification, r) => {
    expect(classifyFleetClaimHistory(r, window, members)).toEqual({ classification });
  });

  it('refuses a truncated candidate set and never converts an empty set into historical zero proof', () => {
    const over = summarizeFleetClaimHistory(window,
      Array.from({ length: FLEET_CLAIM_HISTORY_MAX_ITEMS + 1 }, () => history([])), members);
    expect(over).toMatchObject({ candidateSetComplete: false, classificationCounts: {}, conditionalMemberHeldItems: 0,
      qualifiesHistoricalTotal: false });
    expect(summarizeFleetClaimHistory(window, [], members)).toMatchObject({
      candidateSetComplete: true, observedCandidates: 0, historicalPopulationVerified: false, qualifiesHistoricalTotal: false });
  });
});
