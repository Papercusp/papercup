/**
 * decline_release_request.test.ts — work_items:decline_release_request handler (WI-5974).
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

const decline = (await import('./decline_release_request')).default;

const parse = (x: unknown) => (decline.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown, ctx: unknown = {}) => {
  const res = (await decline.handler(parse(x) as never, ctx as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

const pendingPayload = (by = 'requester-1') => ({
  release_request_by: by,
  release_request_holder: 'me',
  release_request_reason: 'stalled',
  release_request_on_silence: 'reclaim',
  release_request_deadline_at: Date.now() + 60_000,
  release_request_requested_at: Date.now(),
  release_request_resolved: false,
  release_request_resolution: null,
  release_request_resolved_at: null,
});

function itemWith(assignee: string | null, payload: Record<string, unknown> | null = null, harness = 'papercup') {
  return { id: 'WI-9', harness, assignee, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  commentWorkItem.mockResolvedValue({ id: 'post-1' });
  sendMessage.mockResolvedValue(undefined);
});

describe('work_items:decline_release_request', () => {
  it('not found → refuses', async () => {
    getWorkItem.mockResolvedValue(null);
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: "work_item 'WI-9' not found" });
  });

  it('WI-6746: an unreadable item reports a READ FAILURE, never "not found"', async () => {
    getWorkItem.mockRejectedValue(new Error('statement timeout'));
    const out = await call({ id: 'WI-9' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('work_item_unreadable');
    expect(out.error).not.toMatch(/not found/i);
  });

  it('you are not the current holder → not_holder', async () => {
    getWorkItem.mockResolvedValue(itemWith('someone-else', pendingPayload()));
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: 'not_holder', holder: 'someone-else' });
    expect(resolveWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('no pending request → no_pending_request', async () => {
    getWorkItem.mockResolvedValue(itemWith('me', null));
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: 'no_pending_request' });
    expect(resolveWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('an ALREADY-RESOLVED request reads as no_pending_request too', async () => {
    getWorkItem.mockResolvedValue(itemWith('me', { ...pendingPayload(), release_request_resolved: true, release_request_resolution: 'holder-released' }));
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: 'no_pending_request' });
  });

  it('resolveWorkItemReleaseRequest racing to null → already_resolved', async () => {
    getWorkItem.mockResolvedValue(itemWith('me', pendingPayload()));
    resolveWorkItemReleaseRequest.mockResolvedValue(null);
    const out = await call({ id: 'WI-9' });
    expect(out).toMatchObject({ ok: false, error: 'already_resolved' });
  });

  it('happy path: resolves, comments, notifies the requester', async () => {
    getWorkItem.mockResolvedValue(itemWith('me', pendingPayload('requester-1')));
    resolveWorkItemReleaseRequest.mockResolvedValue({ by: 'requester-1', holder: 'me', reason: 'stalled', onSilence: 'reclaim', deadlineAt: 1, requestedAt: 1, resolved: true, resolution: 'holder-declined', resolvedAt: Date.now() });
    const out = await call({ id: 'WI-9', reason: 'still actively working it' });
    expect(out).toMatchObject({ ok: true, resolution: 'holder-declined', requestedBy: 'requester-1' });

    expect(resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-9', { harness: 'papercup', resolution: 'holder-declined' });
    expect(commentWorkItem).toHaveBeenCalledTimes(1);
    expect(commentWorkItem.mock.calls[0][1]).toContain('DECLINED');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ to: ['requester-1'] });
  });
});
