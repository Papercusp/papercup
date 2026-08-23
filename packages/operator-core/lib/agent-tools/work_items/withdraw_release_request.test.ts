/**
 * withdraw_release_request.test.ts — requester-side cancellation of a pending
 * work_items:request_release.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me' }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId }),
}));

const getWorkItem = vi.fn();
const commentWorkItem = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  commentWorkItem: (...a: unknown[]) => commentWorkItem(...a),
}));

const resolveWorkItemReleaseRequest = vi.fn();
vi.mock('../../work-items-release-request', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveWorkItemReleaseRequest: (...a: unknown[]) => resolveWorkItemReleaseRequest(...a),
}));

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

const withdraw = (await import('./withdraw_release_request')).default;

const parse = (x: unknown) => (withdraw.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown, ctx: unknown = {}) => {
  const res = (await withdraw.handler(parse(x) as never, ctx as never)) as {
    data?: unknown;
    content?: Array<{ text: string }>;
  };
  return res.data ?? JSON.parse(res.content![0].text);
};

const pendingPayload = (by = 'me', holder = 'holder-1') => ({
  release_request_by: by,
  release_request_holder: holder,
  release_request_reason: 'stalled',
  release_request_on_silence: 'reclaim',
  release_request_deadline_at: Date.now() + 60_000,
  release_request_requested_at: Date.now(),
  release_request_resolved: false,
  release_request_resolution: null,
  release_request_resolved_at: null,
});

function itemWith(assignee: string | null, payload: Record<string, unknown> | null = null, harness = 'papercusp') {
  return { id: 'WI-9', harness, assignee, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  commentWorkItem.mockResolvedValue({ id: 'post-1' });
  sendMessage.mockResolvedValue(undefined);
});

describe('work_items:withdraw_release_request', () => {
  it('not found → refuses', async () => {
    getWorkItem.mockResolvedValue(null);
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: "work_item 'WI-9' not found" });
  });

  it('unreadable item reports a READ FAILURE', async () => {
    getWorkItem.mockRejectedValue(new Error('statement timeout'));
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain('work_item_unreadable');
    expect(out.error).not.toMatch(/not found/i);
  });

  it('no pending request → no_pending_request', async () => {
    getWorkItem.mockResolvedValue(itemWith('holder-1', null));
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: 'no_pending_request' });
    expect(resolveWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('a request filed by someone else → not_requester', async () => {
    getWorkItem.mockResolvedValue(itemWith('holder-1', pendingPayload('other-requester')));
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: 'not_requester', requestedBy: 'other-requester', holder: 'holder-1' });
    expect(resolveWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('a resolution race → already_resolved', async () => {
    getWorkItem.mockResolvedValue(itemWith('holder-1', pendingPayload()));
    resolveWorkItemReleaseRequest.mockResolvedValue(null);
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: 'already_resolved' });
  });

  it('withdraws with requester and holder CAS guards, comments, and notifies the holder', async () => {
    getWorkItem.mockResolvedValue(itemWith('holder-1', pendingPayload()));
    resolveWorkItemReleaseRequest.mockResolvedValue({
      by: 'me',
      holder: 'holder-1',
      reason: 'stalled',
      onSilence: 'reclaim',
      deadlineAt: 1,
      requestedAt: 1,
      resolved: true,
      resolution: 'requester-withdrawn',
      resolvedAt: Date.now(),
    });

    const out = await call({ id: 'WI-9', reason: 'successor already has it' });
    expect(out).toMatchObject({ ok: true, id: 'WI-9', resolution: 'requester-withdrawn', holder: 'holder-1' });
    expect(resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-9', {
      harness: 'papercusp',
      resolution: 'requester-withdrawn',
      expectedBy: 'me',
      expectedHolder: 'holder-1',
    });
    expect(commentWorkItem).toHaveBeenCalledTimes(1);
    expect(commentWorkItem.mock.calls[0][1]).toContain('WITHDREW');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ to: ['holder-1'] });
  });
});
