/**
 * change-feed.test.ts — unit tests for the Change Feed projection service.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  gatherCompletions,
  rankChangeFeed,
  dedupById,
  type ChangeFeedEntry,
  type ChangeFeedReaders,
} from './change-feed';

const mockEntries: ChangeFeedEntry[] = [
  {
    id: 'wi:F-001',
    kind: 'completion',
    title: 'Feature 1 completed',
    harness: 'papercup',
    workItemId: 'F-001',
    ref: 'wi:F-001',
    ts: '2026-06-06T10:00:00Z',
    userRequested: true,
  },
  {
    id: 'wi:F-002',
    kind: 'completion',
    title: 'Feature 2 completed',
    harness: 'papercup',
    workItemId: 'F-002',
    ref: 'wi:F-002',
    ts: '2026-06-06T09:00:00Z',
    userRequested: false,
  },
  {
    id: 'gym:proposal-001',
    kind: 'proposal',
    title: 'Accepted prompt for judge',
    ref: 'gym:proposal-001',
    ts: '2026-06-06T08:00:00Z',
    userRequested: false,
  },
  {
    id: 'plan:test-plan',
    kind: 'plan-run',
    title: 'Plan test-plan completed',
    ref: 'plan:test-plan',
    ts: '2026-06-06T07:00:00Z',
    userRequested: true,
  },
];

const mockReaders: ChangeFeedReaders = {
  async workItemCompletions() {
    return mockEntries.filter((e) => e.kind === 'completion');
  },
  async gymProposals() {
    return mockEntries.filter((e) => e.kind === 'proposal');
  },
  async planRuns() {
    return mockEntries.filter((e) => e.kind === 'plan-run');
  },
};

describe('Change Feed', () => {
  describe('gatherCompletions', () => {
    it('gathers entries from all sources', async () => {
      const result = await gatherCompletions(mockReaders);
      expect(result).toHaveLength(4);
    });

    it('deduplicates entries by id', async () => {
      const dupReaders: ChangeFeedReaders = {
        async workItemCompletions() {
          return [mockEntries[0], mockEntries[0]]; // duplicate
        },
        async gymProposals() {
          return [];
        },
        async planRuns() {
          return [];
        },
      };
      const result = await gatherCompletions(dupReaders);
      expect(result).toHaveLength(1);
    });

    it('sorts by timestamp newest-first', async () => {
      const result = await gatherCompletions(mockReaders);
      expect(result[0].ts).toBe('2026-06-06T10:00:00Z');
      expect(result[result.length - 1].ts).toBe('2026-06-06T07:00:00Z');
    });

    // CUR-2 PIN: dedup runs over [...wis, ...gyms, ...plans] BEFORE the sort, so
    // it is first-wins by SOURCE ORDER (work-items, then gyms, then plans) — NOT
    // by recency. A work-item shadows a same-id plan even when the plan's ts is
    // newer. Intentional but undocumented; pin so a "sort then dedup" refactor
    // can't silently flip which record survives.
    it('dedups across sources first-wins by source order, not recency (CUR-2)', async () => {
      const collidingReaders: ChangeFeedReaders = {
        async workItemCompletions() {
          return [{ id: 'x', kind: 'completion', title: 'from work-item', ref: 'wi:x', ts: '2026-06-08T00:00:00Z' }];
        },
        async gymProposals() {
          return [];
        },
        async planRuns() {
          return [{ id: 'x', kind: 'plan-run', title: 'from plan (newer)', ref: 'plan:x', ts: '2026-06-09T00:00:00Z' }];
        },
      };
      const result = await gatherCompletions(collidingReaders);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('from work-item');
      expect(result[0].kind).toBe('completion');
    });

    it('handles reader errors gracefully', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorReaders: ChangeFeedReaders = {
        async workItemCompletions() {
          throw new Error('DB error');
        },
        async gymProposals() {
          return mockEntries.filter((e) => e.kind === 'proposal');
        },
        async planRuns() {
          return [];
        },
      };
      const result = await gatherCompletions(errorReaders);
      // Should return only proposals (work items failed, so empty).
      expect(result.some((e) => e.kind === 'proposal')).toBe(true);
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe('rankChangeFeed', () => {
    it('ranks by userRequested first, then newest', () => {
      const result = rankChangeFeed(mockEntries);
      // User-requested should come first: F-001 and test-plan.
      expect(result[0].userRequested).toBe(true);
      expect(result[0].ts).toBe('2026-06-06T10:00:00Z'); // Newest user-requested.
      expect(result[1].userRequested).toBe(true);
    });

    it('filters by userRequestedOnly', () => {
      const result = rankChangeFeed(mockEntries, { userRequestedOnly: true });
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.userRequested)).toBe(true);
    });

    it('respects limit', () => {
      const result = rankChangeFeed(mockEntries, { limit: 2 });
      expect(result).toHaveLength(2);
    });

    it('returns empty when no entries match filters', () => {
      const result = rankChangeFeed([], { limit: 10 });
      expect(result).toHaveLength(0);
    });

    // CUR-1: the fn claims "newest first (recency)" as its OWN contract, so it
    // must sort by ts even when handed entries in NON-recency order (not only
    // when the caller pre-sorts). Same tier (both fleet-internal completions),
    // input order oldest→newest → output newest-first.
    it('sorts same-tier entries newest-first regardless of input order (CUR-1)', () => {
      const out = rankChangeFeed([
        { id: 'a', kind: 'completion', title: 'a', ref: 'a', ts: '2026-06-01T00:00:00Z' },
        { id: 'b', kind: 'completion', title: 'b', ref: 'b', ts: '2026-06-09T00:00:00Z' },
      ]);
      expect(out.map((e) => e.id)).toEqual(['b', 'a']);
    });

    // CUR-1 (cont.): the recency tie-break is applied WITHIN the userRequested
    // tier, not across it — a newer fleet-internal item never jumps a user item.
    it('keeps userRequested ahead of a newer fleet-internal entry (CUR-1)', () => {
      const out = rankChangeFeed([
        { id: 'fresh', kind: 'completion', title: 'fresh internal', ref: 'fresh', ts: '2026-06-09T00:00:00Z', userRequested: false },
        { id: 'user', kind: 'completion', title: 'older user', ref: 'user', ts: '2026-06-01T00:00:00Z', userRequested: true },
      ]);
      expect(out.map((e) => e.id)).toEqual(['user', 'fresh']);
    });
  });

  describe('dedupById', () => {
    it('removes duplicate entries by id', () => {
      const entries = [mockEntries[0], mockEntries[1], mockEntries[0]];
      const result = dedupById(entries);
      expect(result).toHaveLength(2);
      // First occurrence wins.
      expect(result[0].id).toBe('wi:F-001');
      expect(result[1].id).toBe('wi:F-002');
    });

    it('preserves order (first-wins)', () => {
      const entries = [mockEntries[2], mockEntries[0], mockEntries[2], mockEntries[1]];
      const result = dedupById(entries);
      expect(result[0].id).toBe('gym:proposal-001');
      expect(result[1].id).toBe('wi:F-001');
      expect(result[2].id).toBe('wi:F-002');
    });
  });
});
