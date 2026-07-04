import { describe, it, expect, beforeEach, vi } from 'vitest';
import retireTool from './retire';
import { getDocRecord, deleteDocRecord } from '../../harness/docs/doc-record';
import type { HarnessDocRecord, DocSource } from '../../harness/docs/doc-record';

// PG-free unit: doc-record's deleteDocRecord/getDocRecord have their own coverage
// (doc-record.integration.test.ts); this pins the retire TOOL handler (EI-6492 /
// EI-5921-adjacent) — no-op on a never-recorded doc, delete on an existing one, the
// leading-"./" strip, the harness-scope gate, and bulk correlation/error isolation.
vi.mock('../../harness/docs/doc-record', () => ({
  getDocRecord: vi.fn(),
  deleteDocRecord: vi.fn(),
}));

const mockGet = vi.mocked(getDocRecord);
const mockDelete = vi.mocked(deleteDocRecord);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = { harnessSlug: 'demo' }) {
  return (
    retireTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ data?: any; content?: Array<{ text: string }>; isError?: boolean }>;
    }
  ).handler(args, ctx);
}
const envelope = (r: { data?: any; content?: Array<{ text: string }> }) => (r.data ?? JSON.parse(r.content![0].text));
const body = (r: { data?: any; content?: Array<{ text: string }> }) => envelope(r).results[0];

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
    status: 'review',
    statusDetail: 'bodyMissing',
    statusCheckedAt: null,
    regenEnqueuedAt: null,
    reverifyFlaggedAt: null,
    regenAttempts: 0,
    reverifyAttempts: 0,
    title: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('harness_docs:retire tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
  });

  it('existing record → deletes it, existed:true', async () => {
    mockGet.mockResolvedValueOnce(rec({ source: 'generated' }));
    const res = body(await callTool({ docId: 'features/F-1.md' }));
    expect(mockDelete).toHaveBeenCalledWith('demo', 'features/F-1.md');
    expect(res).toMatchObject({ ok: true, docId: 'features/F-1.md', existed: true });
  });

  it('no existing record → NO-OP: no delete call, existed:false', async () => {
    mockGet.mockResolvedValueOnce(null);
    const res = body(await callTool({ docId: 'features/F-1.md' }));
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, docId: 'features/F-1.md', existed: false });
  });

  it('strips a leading "./" from the docId on every doc-record call', async () => {
    mockGet.mockResolvedValueOnce(rec({ source: 'manual' }));
    await callTool({ docId: './guides/setup.md' });
    expect(mockGet).toHaveBeenCalledWith('demo', 'guides/setup.md');
    expect(mockDelete).toHaveBeenCalledWith('demo', 'guides/setup.md');
  });

  it('no resolvable harness scope → top-level { ok:false, error:"harness_required" } and touches nothing', async () => {
    const res = await callTool({ docId: 'features/F-1.md' }, { harnessSlug: '*' });
    expect(res.isError).toBe(true);
    expect(envelope(res)).toEqual({ ok: false, error: 'harness_required' });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('items:[…] retires MANY docs → { ok, results, counts } correlated by docId', async () => {
    mockGet.mockImplementation(async (_h: string, docId: string) => rec({ docId, source: 'generated' }));
    const env = envelope(await callTool({ items: [{ docId: 'a.md' }, { docId: 'b.md' }] }));
    expect(env).toMatchObject({ ok: true, counts: { ok: 2, failed: 0 } });
    expect(env.results.map((r: { docId: string }) => r.docId)).toEqual(['a.md', 'b.md']);
    expect(mockDelete).toHaveBeenCalledWith('demo', 'a.md');
    expect(mockDelete).toHaveBeenCalledWith('demo', 'b.md');
  });

  it('a per-item throw → that item { ok:false, docId, error }; the batch survives', async () => {
    mockGet.mockImplementation(async (_h: string, docId: string) => {
      if (docId === 'bad.md') throw new Error('boom');
      return rec({ docId, source: 'generated' });
    });
    const env = envelope(await callTool({ items: [{ docId: 'good.md' }, { docId: 'bad.md' }] }));
    expect(env.ok).toBe(true);
    expect(env.counts).toEqual({ ok: 1, failed: 1 });
    expect(env.results[1]).toMatchObject({ ok: false, docId: 'bad.md', error: 'boom' });
  });
});
