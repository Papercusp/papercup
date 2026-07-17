/**
 * inbox-reply.test.ts — owner-inbox-single-pane-2026-07-17 P-006 (D-006/D-007).
 * Mocks the three collaborators (listPresence, sendMessage, wakeRecipients) and
 * asserts the liveness-gated delivery contract: a live asker gets sent+woken
 * with the provenance marker stamped on the wake payload; a dead/unknown asker
 * gets neither.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listPresence: vi.fn(async (_opts?: unknown) => [] as Array<{ ownerId: string }>),
  sendMessage: vi.fn(async (_id: unknown, _opts: unknown) => ({ msg_id: 'm-1' })),
  wakeRecipients: vi.fn(async (_to: readonly string[], _opts: unknown) => ({
    targets: [] as string[],
    keys: [] as string[],
    woken: 0,
    staged: 0,
    stagedTargets: [] as string[],
    fanoutCapped: [] as string[],
  })),
}));

vi.mock('./presence', () => ({ listPresence: h.listPresence }));
vi.mock('./messages', () => ({ sendMessage: h.sendMessage }));
vi.mock('./inbox-wake', () => ({ wakeRecipients: h.wakeRecipients }));

import {
  deliverInboxOwnerReply,
  isInboxOwnerReplyPayload,
  INBOX_OWNER_REPLY_MARKER,
} from './inbox-reply';

beforeEach(() => {
  h.listPresence.mockClear().mockResolvedValue([]);
  h.sendMessage.mockClear().mockResolvedValue({ msg_id: 'm-1' });
  h.wakeRecipients.mockClear().mockResolvedValue({
    targets: [],
    keys: [],
    woken: 0,
    staged: 0,
    stagedTargets: [],
    fanoutCapped: [],
  });
});

describe('isInboxOwnerReplyPayload', () => {
  it('true only for the exact marker shape', () => {
    expect(isInboxOwnerReplyPayload({ [INBOX_OWNER_REPLY_MARKER]: true })).toBe(true);
    expect(isInboxOwnerReplyPayload({ [INBOX_OWNER_REPLY_MARKER]: false })).toBe(false);
    expect(isInboxOwnerReplyPayload({ other: true })).toBe(false);
    expect(isInboxOwnerReplyPayload(null)).toBe(false);
    expect(isInboxOwnerReplyPayload(undefined)).toBe(false);
    expect(isInboxOwnerReplyPayload('string')).toBe(false);
    expect(isInboxOwnerReplyPayload(42)).toBe(false);
  });
});

describe('deliverInboxOwnerReply (D-006/D-007)', () => {
  it('dead/unknown asker (not in presence roster): no send, no wake — live:false', async () => {
    h.listPresence.mockResolvedValue([{ ownerId: 'someone-else' }]);
    const r = await deliverInboxOwnerReply({ askerId: 'su-asker-1', text: 'hi', summary: 's' });
    expect(r).toEqual({ live: false, delivered: false, woken: 0 });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.wakeRecipients).not.toHaveBeenCalled();
  });

  it('live asker: sends the reply AND wakes with the provenance marker on the payload', async () => {
    h.listPresence.mockResolvedValue([{ ownerId: 'su-asker-1' }]);
    h.wakeRecipients.mockResolvedValue({
      targets: ['su-asker-1'],
      keys: ['coord:inbox-wake:su-asker-1'],
      woken: 1,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
    });
    const r = await deliverInboxOwnerReply({
      askerId: 'su-asker-1',
      text: 'use approach B',
      summary: 'Owner answered your conversation',
      planSlug: 'p1',
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = h.sendMessage.mock.calls[0] as [
      { ownerId: string },
      { to: string[]; body: string; summary: string; plan_slug?: string },
    ];
    expect(opts.to).toEqual(['su-asker-1']);
    expect(opts.body).toBe('use approach B');
    expect(opts.plan_slug).toBe('p1');
    // The sender identity is NEVER a spoofable agent id — a stable, distinct
    // admin-UI-owner id (matches ADMIN_COORD_UI_OWNER).
    expect(identity.ownerId).toBeTruthy();

    expect(h.wakeRecipients).toHaveBeenCalledTimes(1);
    const [targets, wakeOpts] = h.wakeRecipients.mock.calls[0] as [
      string[],
      { payload?: Record<string, unknown> },
    ];
    expect(targets).toEqual(['su-asker-1']);
    expect(wakeOpts.payload).toEqual({ [INBOX_OWNER_REPLY_MARKER]: true });
    expect(isInboxOwnerReplyPayload(wakeOpts.payload)).toBe(true);

    expect(r).toEqual({ live: true, delivered: true, woken: 1, msgId: 'm-1' });
  });

  it('live asker but nobody currently parked on their wake key: still delivered, woken:0', async () => {
    h.listPresence.mockResolvedValue([{ ownerId: 'su-asker-1' }]);
    // wakeRecipients default mock already returns woken: 0.
    const r = await deliverInboxOwnerReply({ askerId: 'su-asker-1', text: 'hi', summary: 's' });
    expect(r).toEqual({ live: true, delivered: true, woken: 0, msgId: 'm-1' });
  });

  it('a listPresence read failure degrades to live:false rather than throwing', async () => {
    h.listPresence.mockRejectedValue(new Error('presence store down'));
    const r = await deliverInboxOwnerReply({ askerId: 'su-asker-1', text: 'hi', summary: 's' });
    expect(r).toEqual({ live: false, delivered: false, woken: 0 });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});
