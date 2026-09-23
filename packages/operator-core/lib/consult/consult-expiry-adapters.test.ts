/**
 * EI-21559794492221235 — the `system:consult-expiry-sweep` production adapters.
 *
 * ── WHAT THIS FILE IS EVIDENCE OF ──────────────────────────────────────────────
 * Every assertion below CALLS the adapter. Before the extraction these lived as
 * lambdas inside a `registerSystemAction` closure, so the only thing a suite could do
 * with them was match their source text — which cannot catch a wrong field, a wrong
 * parameter, or a workspace threaded from the wrong place. That this file can exist
 * at all is the point of the change.
 *
 * ── WHY THESE PARTICULAR ASSERTIONS ────────────────────────────────────────────
 * `consult_state` is workspace-PARTITIONED and ONE sweep serves every workspace, so
 * each adapter must carry the workspace from the ROW it was handed. Taking it from
 * ambient scope instead addresses the wrong tenant while still passing every
 * `consult-expiry-core` test, because the core supplies the workspace and never checks
 * where the adapter sourced it. So the tests pass a row workspace that is deliberately
 * DIFFERENT from any plausible ambient default and assert it arrives intact.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CONSULT_EXPIRY_SWEEP_OWNER_ID,
  consultExpiryEmitReplyEvent,
  consultExpiryFindSilentResponders,
  consultExpiryNotifyRequester,
  consultExpiryDispatch,
  sweepIdentity,
  type AwaitedEventEmitter,
  type ConsultDispatcherFactory,
} from './consult-expiry-adapters';
import { requesterAlertForRow, type DueConsultRow } from './consult-expiry-core';
import { currentRequestWorkspaceId, runWithWorkspace } from '../workspace-als';

/** A row workspace that could not be mistaken for an ambient/default one. */
const ROW_WS = 'ws-row-7f3a';

const alertRow: DueConsultRow = {
  workspace_id: ROW_WS, conversation_id: 'conv-alert', requester_id: 'su-requester',
  responder_id: 'su-reviewer', state: 'awaiting_responder', is_due: true,
  updated_at: '2026-09-20T00:00:00Z', latency_contract: 'hard-blocked',
  question: 'review this', routing: {}, cascade_cursor: 0, cascade_digest: [],
};

describe('P-005 durable requester alert', () => {
  it('uses a stable lifecycle key across clocks/reasons and distinct keys across consults, workspaces, and positions', () => {
    const make = (row: DueConsultRow, kind: 'expired' | 'pickup_failed' = 'expired', nowIso = '2026-09-20T01:00:00Z') =>
      requesterAlertForRow({ row, kind, nowIso });
    const first = make(alertRow);
    expect(make(alertRow, 'pickup_failed', '2026-09-20T02:00:00Z').msgId).toBe(first.msgId);
    expect(new Set([
      first.msgId,
      make({ ...alertRow, conversation_id: 'conv-other' }).msgId,
      make({ ...alertRow, workspace_id: 'ws-other' }).msgId,
      make({ ...alertRow, cascade_cursor: 1 }).msgId,
      make({ ...alertRow, workspace_id: 'ws:conv', conversation_id: 'alert' }).msgId,
      make({ ...alertRow, workspace_id: 'ws', conversation_id: 'conv:alert' }).msgId,
    ]).size).toBe(6);
  });

  it.each(['hard-blocked', 'proceed'])('names the exact consult and honest pending recovery for %s', (latency_contract) => {
    const alert = requesterAlertForRow({
      row: { ...alertRow, latency_contract }, kind: 'expired', nowIso: '2026-09-20T01:00:00Z',
    });
    expect(alert.summary).toContain(alertRow.conversation_id);
    expect(alert.body).toContain(`conversation_id: "${alertRow.conversation_id}"`);
    expect(alert.body).toContain('Recovery disposition: pending');
    expect(alert.body).toContain('never approval');
    expect(alert.body).toContain(latency_contract === 'hard-blocked'
      ? `await consult:reply:${alertRow.conversation_id}` : 'Continue independent work');
    // A due row may still ADVANCE; expiry of one wait is not cascade exhaustion.
    expect(alert.body).toContain('if the cascade is exhausted');
  });

  it('threads replay key, recipient, content and ROW workspace through the real ALS scope, then restores ambient scope', async () => {
    const alert = requesterAlertForRow({ row: alertRow, kind: 'pickup_failed', nowIso: '2026-09-20T01:00:00Z' });
    const send = vi.fn(async (identity, opts) => {
      await Promise.resolve();
      expect(currentRequestWorkspaceId()).toBe(ROW_WS);
      expect(identity).toMatchObject({ workspaceId: ROW_WS, ownerId: CONSULT_EXPIRY_SWEEP_OWNER_ID });
      expect(opts).toEqual({
        msgId: alert.msgId, to: ['su-requester'], summary: alert.summary, body: alert.body, harnessSlug: null,
        extra: { conversation_id: alert.conversationId, recovery: 'pending' },
      });
    });
    await runWithWorkspace('ambient-other', async () => {
      await consultExpiryNotifyRequester(send)(alert);
      expect(currentRequestWorkspaceId()).toBe('ambient-other');
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('propagates durable-write failures so the sweep can retry instead of silently consuming the lifecycle row', async () => {
    const send = vi.fn(async () => { throw new Error('coord write failed'); });
    const alert = requesterAlertForRow({ row: alertRow, kind: 'expired', nowIso: '2026-09-20T01:00:00Z' });
    await expect(consultExpiryNotifyRequester(send)(alert)).rejects.toThrow('coord write failed');
  });
});

describe('sweepIdentity', () => {
  it('takes the workspace from its argument and uses the real sweep ownerId', () => {
    const id = sweepIdentity(ROW_WS);

    expect(id.workspaceId).toBe(ROW_WS);
    expect(id.ownerId).toBe(CONSULT_EXPIRY_SWEEP_OWNER_ID);
    expect(id.ownerId).toBe('system:consult-expiry-sweep');
  });
});

describe('consultExpiryEmitReplyEvent', () => {
  it("emits into the ROW's workspace and stamps the sweep as the source", async () => {
    const seen: Record<string, unknown>[] = [];
    const emit = (async (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return {} as never;
    }) as AwaitedEventEmitter;

    await consultExpiryEmitReplyEvent(emit)({
      key: 'consult:reply:conv-1',
      summary: 'window elapsed',
      payload: { reason: 'expired' },
      to: ['su-requester'],
      workspaceId: ROW_WS,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      key: 'consult:reply:conv-1',
      summary: 'window elapsed',
      payload: { reason: 'expired' },
      to: ['su-requester'],
      workspaceId: ROW_WS,
      source: 'consult-expiry-sweep',
    });
  });
});

describe('consultExpiryDispatch', () => {
  it('builds the dispatcher from the ROW workspace, not an ambient one', async () => {
    let ctxArg: Record<string, unknown> = {};
    const makeDispatcher = ((ctx: Record<string, unknown>) => {
      ctxArg = ctx;
      return async () => {
        expect(currentRequestWorkspaceId()).toBe(ROW_WS);
        return { woke: 1, answeringOwnerId: 'su-next-fork' };
      };
    }) as ConsultDispatcherFactory;

    await runWithWorkspace('ambient-other', async () => {
      await consultExpiryDispatch(makeDispatcher)({
        responder: 'su-next',
        conversationId: 'conv-1',
        summary: 's',
        body: 'b',
        workspaceId: ROW_WS,
      });
      expect(currentRequestWorkspaceId()).toBe('ambient-other');
    });

    expect(ctxArg.workspaceId).toBe(ROW_WS);
    expect(ctxArg.launchedBy).toBe(CONSULT_EXPIRY_SWEEP_OWNER_ID);
    expect(ctxArg.harnessSlug).toBeNull();
  });

  it('builds the dispatcher PER ROW — a hoisted factory call would bind every launch to the first tenant', async () => {
    const seen: string[] = [];
    const makeDispatcher = ((ctx: { workspaceId: string }) => {
      seen.push(ctx.workspaceId);
      return async () => ({ woke: 1, answeringOwnerId: null });
    }) as ConsultDispatcherFactory;
    const dispatch = consultExpiryDispatch(makeDispatcher);

    await dispatch({ responder: 'a', conversationId: 'c1', summary: 's', body: 'b', workspaceId: ROW_WS });
    await dispatch({ responder: 'b', conversationId: 'c2', summary: 's', body: 'b', workspaceId: 'ws-second' });

    expect(seen).toEqual([ROW_WS, 'ws-second']);
  });

  it('passes the expert as the dispatch SOURCE and narrows the result to { woke, answeringOwnerId }', async () => {
    let opts: { responder?: string; conversationId?: string } = {};
    const makeDispatcher = (() => async (o: { responder: string; conversationId: string }) => {
      opts = o;
      return { queued: 1, woke: 1, pickupConfirmed: true, answeringOwnerId: 'su-next-fork', extra: 'ignored' };
    }) as ConsultDispatcherFactory;

    const out = await consultExpiryDispatch(makeDispatcher)({
      responder: 'su-next',
      conversationId: 'conv-42',
      summary: 's',
      body: 'b',
      workspaceId: ROW_WS,
    });

    expect(opts.responder).toBe('su-next');
    expect(opts.conversationId).toBe('conv-42');
    expect(out).toEqual({ woke: 1, answeringOwnerId: 'su-next-fork' });
  });
});

describe('consultExpiryFindSilentResponders', () => {
  it('requires active-after-route + parked + zero posts, and reads each thread in its row workspace', async () => {
    const routedAt = '2026-08-27T05:00:00.000Z';
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-positive', responderId: 'su-parked', routedAt },
      { workspaceId: 'ws-live', conversationId: 'conv-live', responderId: 'su-live', routedAt },
      { workspaceId: 'ws-before', conversationId: 'conv-before', responderId: 'su-before', routedAt },
      { workspaceId: 'ws-posted', conversationId: 'conv-posted', responderId: 'su-posted', routedAt },
    ];
    const presence = new Map([
      ['su-parked', { lastActiveAt: '2026-08-27T05:01:00.000Z' }],
      ['su-live', { lastActiveAt: '2026-08-27T05:01:00.000Z' }],
      ['su-before', { lastActiveAt: '2026-08-27T04:59:00.000Z' }],
      ['su-posted', { lastActiveAt: '2026-08-27T05:01:00.000Z' }],
    ]);
    const verdicts = new Map([
      ['su-parked', { sessionState: 'parked' }],
      ['su-live', { sessionState: 'live' }],
      ['su-before', { sessionState: 'parked' }],
      ['su-posted', { sessionState: 'parked' }],
    ]);
    const resolveSessionStates = vi.fn(
      async (subjects: readonly { ownerId: string }[], opts: { hydratePerId: true }) => {
        expect(subjects.map((subject) => subject.ownerId)).toEqual([
          'su-parked',
          'su-live',
          'su-before',
          'su-posted',
        ]);
        expect(opts).toEqual({ hydratePerId: true });
        return verdicts;
      },
    );
    const threadStoreCalls: string[] = [];
    const parentCalls: Array<{ workspaceId: string; ref: string }> = [];
    const getThreadStore = vi.fn((workspaceId: string) => {
      threadStoreCalls.push(workspaceId);
      return {
        getThreadByParent: async (parent: { kind: string; ref: string }) => {
          parentCalls.push({ workspaceId, ref: parent.ref });
          return { thread_id: `thread-${parent.ref}` } as never;
        },
        listRecentPosts: async (threadId: string) => ({
          posts: [],
          total: threadId === 'thread-conv-posted' ? 1 : 0,
        }),
      };
    });

    const found = await consultExpiryFindSilentResponders({
      getPresence: async (ownerId) => presence.get(ownerId) ?? null,
      resolveSessionStates,
      getThreadStore,
      now: () => new Date('2026-08-27T05:02:00.000Z'),
    })(rows);

    expect(found).toEqual(new Set(['conv-positive']));
    expect(threadStoreCalls).toEqual(expect.arrayContaining([ROW_WS, 'ws-posted']));
    expect(parentCalls).toEqual(
      expect.arrayContaining([
        { workspaceId: ROW_WS, ref: 'conv-positive' },
        { workspaceId: 'ws-posted', ref: 'conv-posted' },
      ]),
    );
    expect(parentCalls).not.toEqual(expect.arrayContaining([{ workspaceId: 'ws-live', ref: 'conv-live' }]));
    expect(parentCalls).not.toEqual(expect.arrayContaining([{ workspaceId: 'ws-before', ref: 'conv-before' }]));
  });

  it('bounds a continuously-live no-pickup responder at the hard-blocked window, but not before it', async () => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const staleRoute = new Date(now.getTime() - 30 * 60_000).toISOString();
    const freshRoute = new Date(now.getTime() - 30 * 60_000 + 1).toISOString();
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-live-stale', responderId: 'su-live-stale', routedAt: staleRoute },
      { workspaceId: ROW_WS, conversationId: 'conv-live-fresh', responderId: 'su-live-fresh', routedAt: freshRoute },
      { workspaceId: ROW_WS, conversationId: 'conv-live-posted', responderId: 'su-live-posted', routedAt: staleRoute },
    ];
    const verdicts = new Map(rows.map((row) => [row.responderId, { sessionState: 'live' }]));
    const threadReads: string[] = [];

    const found = await consultExpiryFindSilentResponders({
      // A live busy turn need not update presence after the consult route; the
      // bounded window + empty thread are the pickup evidence for this branch.
      getPresence: async () => ({ lastActiveAt: null }),
      resolveSessionStates: async () => verdicts,
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async (threadId) => {
          threadReads.push(threadId);
          return { total: threadId === 'thread-conv-live-posted' ? 1 : 0 };
        },
      }),
      now: () => now,
    })(rows);

    expect(found).toEqual(new Set(['conv-live-stale']));
    expect(threadReads).toEqual(
      expect.arrayContaining(['thread-conv-live-stale', 'thread-conv-live-posted']),
    );
    expect(threadReads).not.toContain('thread-conv-live-fresh');
  });

  it.each(['ended', 'recorded'] as const)(
    'advances a terminal no-pickup responder without waiting for the expiry window (%s)',
    async (sessionState) => {
      const routedAt = '2026-08-27T05:59:59.000Z';
      const rows = [
        { workspaceId: ROW_WS, conversationId: `conv-${sessionState}`, responderId: `su-${sessionState}`, routedAt },
        { workspaceId: ROW_WS, conversationId: `conv-posted-${sessionState}`, responderId: `su-posted-${sessionState}`, routedAt },
      ];
      const verdicts = new Map([
        [rows[0]!.responderId, { sessionState }],
        [rows[1]!.responderId, { sessionState }],
      ]);
      const resolveSessionStates = vi.fn(async () => verdicts);
      const threadReads: string[] = [];

      const found = await consultExpiryFindSilentResponders({
        getPresence: async () => null,
        resolveSessionStates,
        getThreadStore: () => ({
          getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
          listRecentPosts: async (threadId) => {
            threadReads.push(threadId);
            return { total: threadId === `thread-conv-posted-${sessionState}` ? 1 : 0 };
          },
        }),
        now: () => new Date('2026-08-27T06:00:00.000Z'),
      })(rows);

      expect(found).toEqual(new Set([`conv-${sessionState}`]));
      expect(threadReads).toEqual(
        expect.arrayContaining([`thread-conv-${sessionState}`, `thread-conv-posted-${sessionState}`]),
      );
    },
  );

  it('bounds a parked responder that never became active after the pickup window', async () => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const staleRoute = new Date(now.getTime() - 30 * 60_000).toISOString();
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-parked-stale', responderId: 'su-parked-stale', routedAt: staleRoute },
      { workspaceId: ROW_WS, conversationId: 'conv-parked-fresh', responderId: 'su-parked-fresh', routedAt: now.toISOString() },
    ];

    const found = await consultExpiryFindSilentResponders({
      getPresence: async () => ({ lastActiveAt: null }),
      resolveSessionStates: async () =>
        new Map(rows.map((row) => [row.responderId, { sessionState: 'parked' }])),
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async () => ({ total: 0 }),
      }),
      now: () => now,
    })(rows);

    expect(found).toEqual(new Set(['conv-parked-stale']));
  });

  it.each(['unknown', 'draining', 'suspect'] as const)(
    'does not recover a %s responder without terminal or empty-pickup evidence',
    async (sessionState) => {
      const now = new Date('2026-08-27T06:00:00.000Z');
      const staleRoute = new Date(now.getTime() - 60 * 60_000).toISOString();
      const getThreadStore = vi.fn(() => {
        throw new Error('thread store must not be read for an unresolved responder');
      });

      const found = await consultExpiryFindSilentResponders({
        getPresence: async () => null,
        resolveSessionStates: async () =>
          new Map([['su-unresolved', { sessionState }]]),
        getThreadStore,
        now: () => now,
      })([
        {
          workspaceId: ROW_WS,
          conversationId: `conv-${sessionState}`,
          responderId: 'su-unresolved',
          routedAt: staleRoute,
        },
      ]);

      expect(found).toEqual(new Set());
      expect(getThreadStore).not.toHaveBeenCalled();
    },
  );
});
