import { describe, it, expect, beforeEach, vi } from 'vitest';
import setOverlayTool from './set_overlay';
import { getDocRecord, setDocOverlay, upsertDocRecord } from '../../harness/docs/doc-record';
import type { HarnessDocRecord, DocSource } from '../../harness/docs/doc-record';

// PG-free unit: the doc-record helpers have their own coverage; this pins the
// set_overlay TOOL handler (P-005 / D-003) — the minimal-record bootstrap for a
// never-recorded doc (upsert BEFORE setDocOverlay), non-empty vs empty-string
// (clear → null overlay, hasOverlay:false), the leading-"./" strip, and the
// harness-scope gate. (harness-docs-integration-2026-06-05 Gap 11.)
vi.mock('../../harness/docs/doc-record', () => ({
  getDocRecord: vi.fn(),
  setDocOverlay: vi.fn(),
  upsertDocRecord: vi.fn(),
}));

const mockGet = vi.mocked(getDocRecord);
const mockSetOverlay = vi.mocked(setDocOverlay);
const mockUpsert = vi.mocked(upsertDocRecord);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = { harnessSlug: 'demo' }) {
  return (
    setOverlayTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

function rec(over: Partial<HarnessDocRecord> & { source: DocSource }): HarnessDocRecord {
  return {
    workspaceId: 'ws',
    harnessSlug: 'demo',
    docId: 'features/F-1.md',
    subjectRef: [],
    anchorPaths: [],
    generatedFromSha: null,
    lastVerifiedSha: null,
    lastVerifiedAt: null,
    overlay: null,
    status: 'untracked',
    statusDetail: null,
    statusCheckedAt: null,
    regenEnqueuedAt: null,
    reverifyFlaggedAt: null,
    title: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('harness_docs:set_overlay tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetOverlay.mockResolvedValue(undefined);
    mockUpsert.mockResolvedValue(rec({ source: 'manual' }));
  });

  it('no existing record → creates a minimal manual/untracked record BEFORE setDocOverlay', async () => {
    const order: string[] = [];
    mockGet.mockResolvedValueOnce(null); // existence check
    mockUpsert.mockImplementation(async () => { order.push('upsert'); return rec({ source: 'augmented', overlay: 'why' }); });
    mockSetOverlay.mockImplementation(async () => { order.push('setOverlay'); });
    mockGet.mockResolvedValueOnce(rec({ source: 'augmented', overlay: 'why' })); // re-read

    const res = body(await callTool({ docId: 'features/F-1.md', overlay: 'why' }));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'demo', docId: 'features/F-1.md', source: 'manual', status: 'untracked' }),
    );
    expect(order).toEqual(['upsert', 'setOverlay']);
    expect(res).toMatchObject({ ok: true, docId: 'features/F-1.md', source: 'augmented', hasOverlay: true });
  });

  it('existing record → does NOT upsert a minimal record', async () => {
    mockGet.mockResolvedValueOnce(rec({ source: 'generated', generatedFromSha: 'sha' }));
    mockGet.mockResolvedValueOnce(rec({ source: 'augmented', overlay: 'why', generatedFromSha: 'sha' }));
    const res = body(await callTool({ docId: 'features/F-1.md', overlay: 'why' }));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockSetOverlay).toHaveBeenCalledWith('demo', 'features/F-1.md', 'why');
    expect(res).toMatchObject({ ok: true, hasOverlay: true, source: 'augmented' });
  });

  it('non-empty overlay → setDocOverlay(..., overlay verbatim)', async () => {
    mockGet.mockResolvedValueOnce(rec({ source: 'generated', generatedFromSha: 'sha' }));
    mockGet.mockResolvedValueOnce(rec({ source: 'augmented', overlay: 'Why: ships login.', generatedFromSha: 'sha' }));
    await callTool({ docId: 'features/F-1.md', overlay: 'Why: ships login.' });
    expect(mockSetOverlay).toHaveBeenCalledWith('demo', 'features/F-1.md', 'Why: ships login.');
  });

  it('empty-string overlay → setDocOverlay(..., null) + hasOverlay:false (clears)', async () => {
    mockGet.mockResolvedValueOnce(rec({ source: 'augmented', overlay: 'old', generatedFromSha: 'sha' }));
    mockGet.mockResolvedValueOnce(rec({ source: 'generated', overlay: null, generatedFromSha: 'sha' }));
    const res = body(await callTool({ docId: 'features/F-1.md', overlay: '' }));
    expect(mockSetOverlay).toHaveBeenCalledWith('demo', 'features/F-1.md', null);
    expect(res.hasOverlay).toBe(false);
    expect(res.source).toBe('generated');
  });

  it('whitespace-only overlay also clears (trim === "" → null)', async () => {
    mockGet.mockResolvedValueOnce(rec({ source: 'augmented', overlay: 'old' }));
    mockGet.mockResolvedValueOnce(rec({ source: 'manual', overlay: null }));
    await callTool({ docId: 'features/F-1.md', overlay: '   \n  ' });
    expect(mockSetOverlay).toHaveBeenCalledWith('demo', 'features/F-1.md', null);
  });

  it('strips a leading "./" from the docId on every doc-record call', async () => {
    mockGet.mockResolvedValueOnce(rec({ source: 'generated' }));
    mockGet.mockResolvedValueOnce(rec({ source: 'augmented', overlay: 'why' }));
    await callTool({ docId: './features/F-1.md', overlay: 'why' });
    expect(mockGet).toHaveBeenNthCalledWith(1, 'demo', 'features/F-1.md');
    expect(mockSetOverlay).toHaveBeenCalledWith('demo', 'features/F-1.md', 'why');
  });

  it('no resolvable harness scope → { ok:false, error:"harness_required" } and touches nothing', async () => {
    const res = await callTool({ docId: 'features/F-1.md', overlay: 'why' }, { harnessSlug: '*' });
    expect(res.isError).toBe(true);
    expect(body(res)).toEqual({ ok: false, error: 'harness_required' });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockSetOverlay).not.toHaveBeenCalled();
  });
});
