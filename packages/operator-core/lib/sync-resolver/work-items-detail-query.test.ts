// workItems.byHarness summary-slim + workItems.detail on-demand read (P-006).
// byHarness now drops per-row summary at the sync boundary; workItems.detail
// serves the single full enriched row for the Detail pane. Mocks the shared
// assembly at its module boundary so no PG runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

const { listEnrichedWorkItemsMock, getEnrichedWorkItemMock, countWorkItemsMock } = vi.hoisted(() => ({
  listEnrichedWorkItemsMock: vi.fn(async (_o: unknown) => [] as unknown[]),
  getEnrichedWorkItemMock: vi.fn(async (_h: string, _id: string) => null as unknown),
  countWorkItemsMock: vi.fn(async (_f: unknown) => 0),
}));

vi.mock('../endpoint-route/routes/harness/work-items', () => ({
  listEnrichedWorkItems: listEnrichedWorkItemsMock,
  getEnrichedWorkItem: getEnrichedWorkItemMock,
}));
vi.mock('../work-items', () => ({
  countWorkItems: countWorkItemsMock,
  isWorkItemKind: (k: string) => ['change', 'bug', 'task', 'feature', 'research-task', 'chunk'].includes(k),
}));

describe('workItems P-006 (byHarness slim + detail)', () => {
  it('registers both query names', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('workItems.byHarness');
    expect(names).toContain('workItems.detail');
  });

  describe('resolvers', () => {
    beforeEach(() => {
      vi.resetModules();
      listEnrichedWorkItemsMock.mockClear();
      getEnrichedWorkItemMock.mockClear();
      countWorkItemsMock.mockClear();
    });
    afterEach(() => vi.resetModules());

    it('byHarness drops per-row summary but keeps light fields + the total on _meta', async () => {
      listEnrichedWorkItemsMock.mockImplementation(async () => [
        { id: 'WI-1', title: 't1', summary: 'HEAVY'.repeat(500), kind: 'change', state: 'open', assignee: 'su' },
        { id: 'WI-2', title: 't2', summary: 'ALSO HEAVY', kind: 'bug', state: 'open', assignee: null },
      ]);
      countWorkItemsMock.mockImplementation(async () => 1821);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('workItems.byHarness', { harnessSlug: 'papercusp' })) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0].summary).toBe(''); // slimmed
      expect(rows[1].summary).toBe('');
      expect(rows[0].title).toBe('t1'); // light fields kept
      expect(rows[0].assignee).toBe('su');
      expect((rows[0]._meta as { total: number }).total).toBe(1821); // authoritative total preserved
    });

    it('threads an inherited multi-harness scope through both rows and the authoritative count', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('workItems.byHarness', { harnessSlugs: ['root', 'child'] });
      expect(listEnrichedWorkItemsMock).toHaveBeenCalledWith(expect.objectContaining({
        harness: undefined,
        harnesses: ['root', 'child'],
      }));
      expect(countWorkItemsMock).toHaveBeenCalledWith(expect.objectContaining({
        harness: undefined,
        harnesses: ['root', 'child'],
      }));
    });

    it('detail returns the single FULL enriched row (with summary) via getEnrichedWorkItem', async () => {
      getEnrichedWorkItemMock.mockImplementation(async (_h, id) => ({ id, title: 'ti', summary: 'the full summary text', kind: 'change' }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('workItems.detail', { harnessSlug: 'papercusp', id: 'WI-7' })) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('WI-7');
      expect(rows[0].summary).toBe('the full summary text'); // NOT slimmed — detail carries it
      expect(getEnrichedWorkItemMock).toHaveBeenCalledWith('papercusp', 'WI-7');
      expect(listEnrichedWorkItemsMock).not.toHaveBeenCalled();
    });

    it('detail returns [] when the id is not found in the harness', async () => {
      getEnrichedWorkItemMock.mockImplementation(async () => null);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('workItems.detail', { harnessSlug: 'papercusp', id: 'WI-nope' })) as unknown[];
      expect(rows).toEqual([]);
    });
  });
});
