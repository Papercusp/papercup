import { describe, expect, it, vi } from 'vitest';
import {
  buildUnattendedRunOwnerDigest,
  deliverUnattendedRunOwnerDigest,
  UNATTENDED_BULK_REQUESTER,
  UNATTENDED_REVERSAL_WINDOW_MS,
} from './bulk-run-owner-digest';

const FINISHED = '2026-09-01T04:00:00.000Z';
const run = {
  runId: 'bulk-nightly-1',
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
  requestedBy: UNATTENDED_BULK_REQUESTER,
  phase: 'complete' as const,
  finishedAt: FINISHED,
  updatedAt: FINISHED,
  createdAt: '2026-09-01T03:58:00.000Z',
  autoResolved: 2,
};

const items = [
  {
    itemId: 'coord-message:m-1',
    title: 'Acknowledge a completed handoff',
    outcome: 'auto_resolved' as const,
    actionId: 'ack',
    rationale: 'The recipient supplied completion evidence.',
  },
  {
    itemId: 'coord-escalation:e-1',
    title: 'Resolve a stale escalation',
    outcome: 'auto_resolved' as const,
    actionId: 'resolve',
    rationale: 'The linked work-item is terminal.',
  },
  {
    itemId: 'conversation:q-1',
    title: 'Owner answer still required',
    outcome: 'recommended' as const,
    actionId: 'resolve',
    rationale: 'Await the owner.',
  },
];

describe('unattended bulk-run owner digest', () => {
  it('names every auto-applied item, links the immutable report, and pins a 24h reversal window', () => {
    const digest = buildUnattendedRunOwnerDigest(run, items);
    expect(digest.autoAppliedItemIds).toEqual(['coord-message:m-1', 'coord-escalation:e-1']);
    expect(digest.body).toContain('coord-message:m-1');
    expect(digest.body).toContain('coord-escalation:e-1');
    expect(digest.body).not.toContain('conversation:q-1');
    expect(digest.reportHref).toBe('/?opcbr=bulk-nightly-1&oprpt=opcbr');
    expect(Date.parse(digest.reversalWindowUntil) - Date.parse(FINISHED)).toBe(UNATTENDED_REVERSAL_WINDOW_MS);
    expect(digest.body).toContain('choose Undo on any applied row before then');
  });

  it('delivers through durable human inbox + replay-safe attention and dedupes a retry', async () => {
    let existing: object | null = null;
    const send = vi.fn(async (_identity, opts: { msgId?: string }) => {
      existing = { msg_id: opts.msgId };
      return existing as never;
    });
    const notify = vi.fn(async () => ({
      recordId: 7,
      deduped: false,
      mobileDelivered: true,
      desktopDelivered: true,
    }));
    const deps = {
      getMessage: vi.fn(async () => existing as never),
      send,
      notify,
    };

    const first = await deliverUnattendedRunOwnerDigest(run, items, deps);
    const retry = await deliverUnattendedRunOwnerDigest(run, items, deps);

    expect(first).toMatchObject({ delivered: true, inboxDeduped: false });
    expect(retry).toMatchObject({ delivered: false, inboxDeduped: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: UNATTENDED_BULK_REQUESTER }),
      expect.objectContaining({
        to: ['human'],
        expectsReply: true,
        extra: expect.objectContaining({
          runId: run.runId,
          reversibleItemIds: ['coord-message:m-1', 'coord-escalation:e-1'],
        }),
      }),
    );
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dedupeKey: `inbox-bulk-resolve:${run.runId}:owner-digest`,
      }),
    );
  });

  it('does not notify for an owner-triggered foreground run', async () => {
    const deps = {
      getMessage: vi.fn(),
      send: vi.fn(),
      notify: vi.fn(),
    };
    expect(
      await deliverUnattendedRunOwnerDigest({ ...run, requestedBy: 'owner:aviynw' }, items, deps as never),
    ).toBeNull();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });
});
