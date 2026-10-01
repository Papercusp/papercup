// workItems.byHarness summary-slim + workItems.detail on-demand read (P-006).
// byHarness now drops per-row summary at the sync boundary; workItems.detail
// serves the single full enriched row for the Detail pane. Mocks the shared
// assembly at its module boundary so no PG runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

const {
  readWorkItemsPageFromStoreMock,
  readWorkItemsSummaryFromStoreMock,
  readWorkItemPresentationsMock,
  getEnrichedWorkItemMock,
  activeWorkspaceIdMock,
} = vi.hoisted(() => ({
  readWorkItemsPageFromStoreMock: vi.fn(),
  readWorkItemsSummaryFromStoreMock: vi.fn(),
  readWorkItemPresentationsMock: vi.fn(async () => new Map()),
  getEnrichedWorkItemMock: vi.fn(async (_h: string, _id: string) => null as unknown),
  activeWorkspaceIdMock: vi.fn(() => 'workspace-test'),
}));

vi.mock('../endpoint-route/routes/harness/work-items', () => ({
  getEnrichedWorkItem: getEnrichedWorkItemMock,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: activeWorkspaceIdMock,
}));
vi.mock('./work-items-list-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./work-items-list-query')>()),
  readWorkItemsPageFromStore: readWorkItemsPageFromStoreMock,
  readWorkItemsSummaryFromStore: readWorkItemsSummaryFromStoreMock,
  readWorkItemPresentations: readWorkItemPresentationsMock,
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
      readWorkItemsPageFromStoreMock.mockReset();
      readWorkItemsPageFromStoreMock.mockResolvedValue({ rows: [], nextCursor: null, hasMore: false });
      readWorkItemsSummaryFromStoreMock.mockReset();
      readWorkItemsSummaryFromStoreMock.mockResolvedValue([{ kind: 'totals', total: 0, matched: 0 }]);
      getEnrichedWorkItemMock.mockClear();
      activeWorkspaceIdMock.mockClear();
    });
    afterEach(() => vi.resetModules());

    it('byHarness drops per-row summary but keeps light fields + the total on _meta', async () => {
      readWorkItemsPageFromStoreMock.mockResolvedValue({
        rows: [
          { id: 'WI-1', title: 't1', summary: '', kind: 'change', state: 'open', assignee: 'su' },
          { id: 'WI-2', title: 't2', summary: '', kind: 'bug', state: 'open', assignee: null },
        ],
        nextCursor: null,
        hasMore: false,
      });
      readWorkItemsSummaryFromStoreMock.mockResolvedValue([
        { kind: 'totals', total: 1821, matched: 2 },
      ]);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('workItems.byHarness', { harnessSlug: 'papercusp' })) as Array<Record<string, unknown>>;
      const [summary] = (await r('workItems.summary', { harnessSlug: 'papercusp' })) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0].summary).toBe(''); // slimmed
      expect(rows[1].summary).toBe('');
      expect(rows[0].title).toBe('t1'); // light fields kept
      expect(rows[0].assignee).toBe('su');
      expect((rows[0]._meta as { total?: number } | undefined)?.total).toBeUndefined();
      expect(summary).toMatchObject({ total: 1821, matched: 2 }); // authoritative corpus total is separate
    });

    it('threads an inherited multi-harness scope through both rows and the companion summary', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('workItems.byHarness', { harnessSlugs: ['root', 'child'] });
      await r('workItems.summary', { harnessSlugs: ['root', 'child'] });
      const normalizedScope = expect.objectContaining({
        args: expect.objectContaining({
          harnessSlug: null,
          harnessSlugs: ['child', 'root'],
        }),
      });
      expect(readWorkItemsPageFromStoreMock).toHaveBeenCalledWith(
        expect.anything(),
        'workspace-test',
        normalizedScope,
      );
      expect(readWorkItemsSummaryFromStoreMock).toHaveBeenCalledWith(
        expect.anything(),
        'workspace-test',
        normalizedScope,
      );
    });

    it('detail returns the single FULL enriched row (with summary) via getEnrichedWorkItem', async () => {
      getEnrichedWorkItemMock.mockImplementation(async (_h, id) => ({ id, title: 'ti', summary: 'the full summary text', kind: 'change' }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('workItems.detail', { harnessSlug: 'papercusp', id: 'WI-7' })) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('WI-7');
      expect(rows[0].summary).toBe('the full summary text'); // NOT slimmed — detail carries it
      expect(getEnrichedWorkItemMock).toHaveBeenCalledWith('papercusp', 'WI-7');
      expect(readWorkItemsPageFromStoreMock).not.toHaveBeenCalled();
    });

    it('detail returns [] when the id is not found in the harness', async () => {
      getEnrichedWorkItemMock.mockImplementation(async () => null);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('workItems.detail', { harnessSlug: 'papercusp', id: 'WI-nope' })) as unknown[];
      expect(rows).toEqual([]);
    });
  });
});
