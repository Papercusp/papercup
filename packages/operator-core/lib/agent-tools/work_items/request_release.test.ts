/**
 * request_release.test.ts — work_items:request_release handler (WI-5974).
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

const setWorkItemReleaseRequest = vi.fn();
vi.mock('../../work-items-release-request', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setWorkItemReleaseRequest: (...a: unknown[]) => setWorkItemReleaseRequest(...a),
}));

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

const requestRelease = (await import('./request_release')).default;

const parse = (x: unknown) => (requestRelease.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown, ctx: unknown = {}) => {
  const res = (await requestRelease.handler(parse(x) as never, ctx as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

function itemWith(assignee: string | null, payload: Record<string, unknown> | null = null, harness = 'papercup') {
  return { id: 'WI-9', harness, assignee, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  commentWorkItem.mockResolvedValue({ id: 'post-1' });
  sendMessage.mockResolvedValue(undefined);
  setWorkItemReleaseRequest.mockResolvedValue({ id: 'WI-9', harness: 'papercup', workspaceId: 'default' });
});

describe('work_items:request_release', () => {
  it('not found → refuses', async () => {
    getWorkItem.mockResolvedValue(null);
    const out = await call({ id: 'WI-9', deadlineSec: 3600, onSilence: 'reclaim', reason: 'orphaned' });
    expect(out).toMatchObject({ ok: false, error: "work_item 'WI-9' not found" });
    expect(setWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('WI-6746: an unreadable item reports a READ FAILURE, never "not found"', async () => {
    // getWorkItem returns null only for a zero-row result — it never catches, so a PG
    // fault throws. Rendering that as "not found" tells the caller their item is gone
    // and sends them to re-file rather than retry.
    getWorkItem.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const out = await call({ id: 'WI-9', deadlineSec: 3600, onSilence: 'reclaim', reason: 'orphaned' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('work_item_unreadable');
    expect(out.error).toMatch(/connection terminated/);
    expect(out.error).not.toMatch(/not found/i);
    expect(setWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('unclaimed item → not_held (nothing to request)', async () => {
    getWorkItem.mockResolvedValue(itemWith(null));
    const out = await call({ id: 'WI-9', deadlineSec: 3600, onSilence: 'reclaim', reason: 'orphaned' });
    expect(out).toMatchObject({ ok: false, error: 'not_held' });
    expect(setWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('you already hold it → self_held', async () => {
    getWorkItem.mockResolvedValue(itemWith('me'));
    const out = await call({ id: 'WI-9', deadlineSec: 3600, onSilence: 'reclaim', reason: 'orphaned' });
    expect(out).toMatchObject({ ok: false, error: 'self_held' });
    expect(setWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('a pending request from a DIFFERENT requester → refuses with request_already_pending', async () => {
    getWorkItem.mockResolvedValue(
      itemWith('peer-holder', {
        release_request_by: 'other-requester',
        release_request_holder: 'peer-holder',
        release_request_reason: 'stalled',
        release_request_on_silence: 'reclaim',
        release_request_deadline_at: Date.now() + 60_000,
        release_request_requested_at: Date.now(),
        release_request_resolved: false,
        release_request_resolution: null,
        release_request_resolved_at: null,
      }),
    );
    const out = await call({ id: 'WI-9', deadlineSec: 3600, onSilence: 'reclaim', reason: 'orphaned' });
    expect(out).toMatchObject({ ok: false, error: 'request_already_pending', existing: { by: 'other-requester' } });
    expect(setWorkItemReleaseRequest).not.toHaveBeenCalled();
  });

  it('the SAME requester may refresh their own pending request', async () => {
    getWorkItem.mockResolvedValue(
      itemWith('peer-holder', {
        release_request_by: 'me',
        release_request_holder: 'peer-holder',
        release_request_reason: 'stalled',
        release_request_on_silence: 'reclaim',
        release_request_deadline_at: Date.now() + 60_000,
        release_request_requested_at: Date.now(),
        release_request_resolved: false,
        release_request_resolution: null,
        release_request_resolved_at: null,
      }),
    );
    const out = await call({ id: 'WI-9', deadlineSec: 3600, onSilence: 'escalate', reason: 'still stalled' });
    expect(out).toMatchObject({ ok: true, holder: 'peer-holder' });
    expect(setWorkItemReleaseRequest).toHaveBeenCalled();
  });

  it('happy path: records the request, comments on the item, messages the holder', async () => {
    getWorkItem.mockResolvedValue(itemWith('peer-holder'));
    const out = await call({ id: 'WI-9', deadlineSec: 3600, onSilence: 'reclaim', reason: 'looks orphaned' });
    expect(out).toMatchObject({ ok: true, id: 'WI-9', holder: 'peer-holder', requestedBy: 'me', onSilence: 'reclaim', reason: 'looks orphaned' });
    expect(out.deadlineAt).toBeGreaterThan(Date.now());

    expect(setWorkItemReleaseRequest).toHaveBeenCalledWith(
      'WI-9',
      expect.objectContaining({
        harness: 'papercup',
        by: 'me',
        holder: 'peer-holder',
        expectedHolder: 'peer-holder',
        reason: 'looks orphaned',
        onSilence: 'reclaim',
      }),
    );
    expect(commentWorkItem).toHaveBeenCalledTimes(1);
    expect(commentWorkItem.mock.calls[0][0]).toBe('WI-9');
    expect(commentWorkItem.mock.calls[0][1]).toContain('RELEASE REQUEST');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ to: ['peer-holder'], expectsReply: true });
  });

  it('setWorkItemReleaseRequest failing (item vanished mid-call) → request_failed', async () => {
    getWorkItem.mockResolvedValue(itemWith('peer-holder'));
    setWorkItemReleaseRequest.mockResolvedValue(null);
    const out = await call({ id: 'WI-9', deadlineSec: 3600, onSilence: 'nothing', reason: 'x' });
    expect(out).toMatchObject({ ok: false, error: 'request_failed' });
  });
});
