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
