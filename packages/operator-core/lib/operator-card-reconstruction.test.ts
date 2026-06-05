import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the data-source modules at the boundary so we exercise only the
// merge logic in `reconstructCards`. Both readLastScan and listDismissed
// were filesystem-based when this test was first written; they're now
// PG-backed (post-migration 025). Mocking them directly keeps the merge
// test hermetic regardless of which storage backend they use.
const lastScanMock = vi.fn<[], Promise<unknown>>();
const dismissedMock = vi.fn<[], unknown[]>();

vi.mock('./operator-last-scan', () => ({
  readLastScan: () => lastScanMock(),
}));
vi.mock('./operator-dismissed-cache', () => ({
  // listDismissed is sync (returns DismissedEntry[]).
  listDismissed: () => dismissedMock(),
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));
// Stub the PG layer — every readOperatorState/withWorkspace call path
// is mocked above. Anything else slipping through should fail loudly.
vi.mock('@papercusp/db-org', () => ({
  withWorkspace: async () => {
    throw new Error('PG unavailable — should be mocked at higher layer');
  },
  getOrgPg: () => {
    throw new Error('PG unavailable — should be mocked at higher layer');
  },
}));

const { reconstructCards } = await import('./operator-card-reconstruction');

beforeEach(() => {
  lastScanMock.mockReset();
  dismissedMock.mockReset();
});

describe('reconstructCards (merge logic)', () => {
  it('returns [] when no last-scan exists', async () => {
    lastScanMock.mockResolvedValue(null);
    dismissedMock.mockReturnValue([]);
    const out = await reconstructCards();
    expect(out).toEqual([]);
  });

  it('hydrates pending from last-scan + dismissed from dismissed list', async () => {
    lastScanMock.mockResolvedValue({
      scanCompletedAt: new Date().toISOString(),
      scanCostUsd: 0.05,
      cards: [
        { id: 'c1', title: 'A', action: 'inform' },
        { id: 'c2', title: 'B', action: 'inform' },
      ],
    });
    dismissedMock.mockReturnValue([{ id: 'c2', dismissedAt: new Date().toISOString() }]);

    const out = await reconstructCards();
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.id === 'c1')?.status).toBe('pending');
    expect(out.find((c) => c.id === 'c2')?.status).toBe('dismissed');
  });
});
