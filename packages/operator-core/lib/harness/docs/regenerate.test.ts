import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestRegeneration } from './regenerate';
import { getDocRecord, markRegenEnqueued, setDocStatus } from './doc-record';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { HarnessDocRecord, DocSource, DocStatus } from './doc-record';

// PG-free + coord-free unit: the doc-record helpers and the coord broadcast each
// have their own coverage; this pins requestRegeneration's 4 branches (D-004) —
// unknown doc, manual refusal, the fresh→stale badge flip before enqueue, and the
// already-stale no-redundant-flip path. (harness-docs-integration-2026-06-05 Gap 9.)
vi.mock('./doc-record', () => ({
  getDocRecord: vi.fn(),
  markRegenEnqueued: vi.fn(),
  setDocStatus: vi.fn(),
}));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: vi.fn() }));

const mockGet = vi.mocked(getDocRecord);
const mockEnqueue = vi.mocked(markRegenEnqueued);
const mockSetStatus = vi.mocked(setDocStatus);
const mockSend = vi.mocked(sendMessage);

function rec(over: Partial<HarnessDocRecord> & { source: DocSource; status: DocStatus }): HarnessDocRecord {
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
    statusDetail: null,
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

describe('requestRegeneration branches (D-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueue.mockResolvedValue(undefined);
    mockSetStatus.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({} as Awaited<ReturnType<typeof sendMessage>>);
  });

  it('(a) record null → { ok:false, error:"unknown_doc" } and never enqueues', async () => {
    mockGet.mockResolvedValue(null);
    const res = await requestRegeneration('demo', 'features/F-1.md');
    expect(res).toEqual({ ok: false, error: 'unknown_doc' });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('(b) source:"manual" → refuses (manual docs are re-verified, not regenerated) without enqueueing', async () => {
    mockGet.mockResolvedValue(rec({ source: 'manual', status: 'review' }));
    const res = await requestRegeneration('demo', 'features/F-1.md');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/manual docs are re-verified, not regenerated/);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it('(c) source:"generated", status:"fresh" → flips to stale THEN enqueues (keeps the badge honest)', async () => {
    mockGet.mockResolvedValue(rec({ source: 'generated', status: 'fresh' }));
    const order: string[] = [];
    mockSetStatus.mockImplementation(async () => { order.push('setStatus'); });
    mockEnqueue.mockImplementation(async () => { order.push('enqueue'); });

    const res = await requestRegeneration('demo', 'features/F-1.md');
    expect(res).toEqual({ ok: true, enqueued: true, docId: 'features/F-1.md' });
    expect(mockSetStatus).toHaveBeenCalledWith('demo', 'features/F-1.md', 'stale', 'regeneration requested', expect.anything());
    expect(mockEnqueue).toHaveBeenCalledOnce();
    // enqueue must precede the status flip in source order (enqueue first, then setDocStatus).
    expect(order).toEqual(['enqueue', 'setStatus']);
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it('(d) source:"generated", status:"stale" → enqueues without a redundant status flip', async () => {
    mockGet.mockResolvedValue(rec({ source: 'generated', status: 'stale' }));
    const res = await requestRegeneration('demo', 'features/F-1.md');
    expect(res).toEqual({ ok: true, enqueued: true, docId: 'features/F-1.md' });
    expect(mockEnqueue).toHaveBeenCalledOnce();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it('augmented (overlaid) generated docs also enqueue (not treated as manual)', async () => {
    mockGet.mockResolvedValue(rec({ source: 'augmented', status: 'stale' }));
    const res = await requestRegeneration('demo', 'features/F-1.md');
    expect(res.ok).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('strips a leading "./" from the docId before looking it up + enqueueing', async () => {
    mockGet.mockResolvedValue(rec({ source: 'generated', status: 'stale' }));
    const res = await requestRegeneration('demo', './features/F-1.md');
    expect(mockGet).toHaveBeenCalledWith('demo', 'features/F-1.md', expect.anything());
    expect(mockEnqueue).toHaveBeenCalledWith('demo', 'features/F-1.md', expect.anything());
    if (res.ok) expect(res.docId).toBe('features/F-1.md');
  });
});
