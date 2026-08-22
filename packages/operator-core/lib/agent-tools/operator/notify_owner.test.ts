import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMessageById, sendMessage, notifyAttentionOnce, resolveAgentIdentity } = vi.hoisted(() => ({
  getMessageById: vi.fn(),
  sendMessage: vi.fn(),
  notifyAttentionOnce: vi.fn(),
  resolveAgentIdentity: vi.fn(),
}));

vi.mock('../coordination/messages', () => ({ getMessageById, sendMessage }));
vi.mock('../../attention-notify', () => ({ notifyAttentionOnce }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity }));

import tool, { ownerNotificationMessageId } from './notify_owner';

const ctx = { workspaceId: 'ws-1', role: 'worker' } as never;
const args = {
  dedupeKey: 'meeting-prep:run-42:owner-brief',
  harness: 'papercusp',
  title: 'Meeting brief ready',
  body: 'Alice — 10:00 AM. Two relevant prior threads.',
  planRunRef: '42',
  sourceRef: 'gcal:event-7',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  resolveAgentIdentity.mockReturnValue({
    ownerId: 'worker-1',
    ownerLabel: 'Worker 1',
    workspaceId: 'ws-1',
    userId: null,
    source: 'principal',
  });
  getMessageById.mockResolvedValue(null);
  sendMessage.mockResolvedValue({ msg_id: 'sent' });
  notifyAttentionOnce.mockResolvedValue({
    recordId: 7,
    deduped: false,
    mobileDelivered: true,
    desktopDelivered: true,
  });
});

describe('notifications:send_owner', () => {
  it('registers the agent-callable owner delivery contract', () => {
    expect(tool.name).toBe('notifications:send_owner');
    expect(tool.capability).toBe('coord:write');
    expect(tool.guidance?.when).toContain('durable inbox');
  });

  it('uses one deterministic coord id and fans out through both existing rails', async () => {
    const out = await tool.handler(args as never, ctx);
    const msgId = ownerNotificationMessageId('ws-1', args.dedupeKey);
    expect(msgId).toMatch(/^[^-]+-\d+-[0-9a-f]{32}$/);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'worker-1' }),
      expect.objectContaining({
        to: ['human'],
        msgId,
        harnessSlug: 'papercusp',
        extra: expect.objectContaining({ deliveryKey: args.dedupeKey, planRunRef: '42' }),
      }),
    );
    expect(notifyAttentionOnce).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: args.dedupeKey,
      workspaceId: 'ws-1',
      data: expect.objectContaining({ planRunRef: '42', sourceRef: 'gcal:event-7' }),
    }));
    expect((out as { data: any }).data).toMatchObject({
      ok: true,
      inbox: { msgId, sent: true, deduped: false },
      attention: { recordId: 7 },
    });
  });

  it('does not append a second inbox row when the deterministic id already exists', async () => {
    getMessageById.mockResolvedValueOnce({ msg_id: ownerNotificationMessageId('ws-1', args.dedupeKey) });
    notifyAttentionOnce.mockResolvedValueOnce({
      recordId: 7,
      deduped: true,
      mobileDelivered: false,
      desktopDelivered: false,
    });
    const out = await tool.handler(args as never, ctx);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((out as { data: any }).data.inbox).toMatchObject({ sent: false, deduped: true });
    expect((out as { data: any }).data.attention.deduped).toBe(true);
  });

  it('treats a concurrent coord unique conflict as a successful dedupe', async () => {
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    const out = await tool.handler(args as never, ctx);
    expect((out as { data: any }).data.inbox).toMatchObject({ sent: false, deduped: true });
    expect(notifyAttentionOnce).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the tool context has no real workspace', async () => {
    resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'worker-1', workspaceId: null });
    await expect(tool.handler(args as never, ctx)).rejects.toThrow('owner_notification_workspace_required');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(notifyAttentionOnce).not.toHaveBeenCalled();
  });
});
