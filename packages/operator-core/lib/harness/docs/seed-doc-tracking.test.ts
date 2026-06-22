import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the PG/FS-touching deps so the SEED WIRING is unit-testable (the deps themselves —
// anchorManualDoc, listDocBodies, resolveHarnessDocPaths — are covered by their own
// integration/unit tests). Mirrors manual-anchor.test.ts's pure-unit approach.
vi.mock('./harness-repo', () => ({ resolveHarnessDocPaths: vi.fn() }));
vi.mock('./doc-fs', () => ({ listDocBodies: vi.fn() }));
vi.mock('./manual-anchor', () => ({ anchorManualDoc: vi.fn() }));
vi.mock('../workspace-for-harness', () => ({
  resolveWorkspaceForHarness: vi.fn(async (_slug: string, ws?: string) => ws ?? 'ws-derived'),
}));

import { seedHarnessDocTracking } from './seed-doc-tracking';
import { resolveHarnessDocPaths } from './harness-repo';
import { listDocBodies } from './doc-fs';
import { anchorManualDoc } from './manual-anchor';

const mockPaths = resolveHarnessDocPaths as unknown as ReturnType<typeof vi.fn>;
const mockList = listDocBodies as unknown as ReturnType<typeof vi.fn>;
const mockAnchor = anchorManualDoc as unknown as ReturnType<typeof vi.fn>;

describe('seedHarnessDocTracking (doc-tracking inheritance — new coding hives doc-honest from birth)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers every doc under docsRoot with verify:true (baseline = current HEAD)', async () => {
    mockPaths.mockResolvedValue({ repoRoot: '/repo', docsRoot: '/repo/docs' });
    mockList.mockResolvedValue(['a.md', 'sub/b.mdx']);
    mockAnchor.mockResolvedValue({ ok: true, record: {}, subjectRef: [], anchored: true });

    const res = await seedHarnessDocTracking({ harnessSlug: 'h', workspaceId: 'ws-1' });

    expect(res).toEqual({ seeded: true, registered: 2, total: 2 });
    expect(mockAnchor).toHaveBeenCalledTimes(2);
    expect(mockAnchor).toHaveBeenCalledWith({ harnessSlug: 'h', docId: 'a.md', verify: true, workspaceId: 'ws-1' });
    expect(mockAnchor).toHaveBeenCalledWith({ harnessSlug: 'h', docId: 'sub/b.mdx', verify: true, workspaceId: 'ws-1' });
  });

  it('reports no_docs_root when the harness has no repo (research / repo-less)', async () => {
    mockPaths.mockResolvedValue(null);
    expect(await seedHarnessDocTracking({ harnessSlug: 'h' })).toEqual({ seeded: false, reason: 'no_docs_root' });
    expect(mockAnchor).not.toHaveBeenCalled();
  });

  it('reports no_docs when docsRoot has no .md/.mdx (fresh empty repo)', async () => {
    mockPaths.mockResolvedValue({ repoRoot: '/repo', docsRoot: '/repo/docs' });
    mockList.mockResolvedValue([]);
    expect(await seedHarnessDocTracking({ harnessSlug: 'h' })).toEqual({ seeded: false, reason: 'no_docs', total: 0 });
    expect(mockAnchor).not.toHaveBeenCalled();
  });

  it('counts only successful anchors (best-effort — a failed anchor never aborts the seed)', async () => {
    mockPaths.mockResolvedValue({ repoRoot: '/repo', docsRoot: '/repo/docs' });
    mockList.mockResolvedValue(['a.md', 'b.md']);
    mockAnchor
      .mockResolvedValueOnce({ ok: true, record: {}, subjectRef: [], anchored: true })
      .mockResolvedValueOnce({ ok: false, error: 'boom' });

    const res = await seedHarnessDocTracking({ harnessSlug: 'h', workspaceId: 'ws-1' });
    expect(res).toEqual({ seeded: true, registered: 1, total: 2 });
  });

  it('never throws — a deps failure degrades to reason:error', async () => {
    mockPaths.mockRejectedValue(new Error('registry down'));
    const res = await seedHarnessDocTracking({ harnessSlug: 'h' });
    expect(res.seeded).toBe(false);
    expect(res.reason).toBe('error');
  });
});
