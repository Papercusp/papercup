/**
 * status.test.ts — events:status projection (GAP 15).
 *
 * Deps mocked (listActiveAwaits / listRecentDeliveries / wakeMeter /
 * resolveAgentIdentity). Asserts the projected field names (await_id/event/policy
 * for awaits; delivery_id/channel/last_error for deliveries), that the meter is
 * omitted unless meter:true, and that all three store reads run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-status', ownerLabel: 's', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../coordination/event-subscriptions', () => ({
  listMyEventKeySubscriptions: vi.fn(),
}));
vi.mock('../coordination/audience-host', () => ({
  hostAudienceResolvers: { listFleetLeader: vi.fn(async () => []) },
}));
vi.mock('../coordination/role-slot-live-resolve', () => ({
  resolveLiveRoleHolders: vi.fn(async () => []),
}));
vi.mock('../coordination/liveness-oracle', () => ({
  resolveSessionStates: vi.fn(async () => new Map()),
}));
vi.mock('../../events/await/store', () => ({
  deliveryBacklogSummary: vi.fn(),
  inspectEventKey: vi.fn(),
  listActiveAwaits: vi.fn(),
  listRecentDeliveries: vi.fn(),
  wakeMeter: vi.fn(),
}));
vi.mock('../../events/await/compose-store', () => ({
  listActiveComposedRoots: vi.fn(async () => []),
  loadTreeLeaves: vi.fn(async () => []),
}));

import status from './status';
import {
  deliveryBacklogSummary,
  inspectEventKey,
  listActiveAwaits,
  listRecentDeliveries,
  wakeMeter,
} from '../../events/await/store';
import { listMyEventKeySubscriptions } from '../coordination/event-subscriptions';
import { hostAudienceResolvers } from '../coordination/audience-host';
import { resolveLiveRoleHolders } from '../coordination/role-slot-live-resolve';
import { resolveSessionStates } from '../coordination/liveness-oracle';
import type { DeliveryRow } from '../../events/await/types';
import type { SubscriptionRow } from '@papercusp/coordination/capabilities';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof status.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await status.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

const AWAIT_ROW = { id: 11, eventKey: 'lock:grant:t1', policy: 'wake', note: 'n', expiresTs: 'E', timeoutBehavior: 'wake', createdAt: 'C' };
// Typed as the real DeliveryRow (EI-21878602849246427) rather than a partial literal cast
// `as never` at each use. The cast defeats vi.mocked()'s signature check, so a fixture that
// goes stale when DeliveryRow gains a required field fails at RUNTIME in an unrelated file
// instead of at compile time here — see testing/typed-mock.ts and WI-6673.
const DELIVERY_ROW: DeliveryRow = {
  id: 22,
  workspaceId: 'ws-x',
  awaitId: 11,
  subscriberId: 'su-status',
  eventKey: 'lock:grant:t1',
  payload: null,
  summary: null,
  status: 'parked',
  channel: 'inbox',
  attempts: 2,
  lastError: 'boom',
  nextAttemptAt: 'C2',
  createdAt: 'C2',
  deliveredAt: null,
  urgent: false,
  minSleepSec: null,
  coalescedCount: 1,
  source: null,
};
const EVENT_SUBSCRIPTION_ROW: SubscriptionRow = {
  id: 33,
  subscriber_id: 'su-status',
  target_kind: 'event',
  target_ref: 'work-item:claimable',
  delivery_mode: 'digest',
  created_ts: 'C3',
  expires_ts: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listActiveAwaits).mockResolvedValue([AWAIT_ROW] as never);
  vi.mocked(listMyEventKeySubscriptions).mockResolvedValue([EVENT_SUBSCRIPTION_ROW]);
  vi.mocked(listRecentDeliveries).mockResolvedValue([DELIVERY_ROW]);
  vi.mocked(deliveryBacklogSummary).mockResolvedValue({
    total: 1,
    pending: 0,
    parked: 1,
    delivering: 0,
    fromCancelledAwaits: 0,
    oldestCreatedAt: 'C2',
  });
  vi.mocked(wakeMeter).mockResolvedValue({ total: 7 } as never);
  vi.mocked(inspectEventKey).mockResolvedValue({ announcements: [], waiters: [], deliveries: [], fireLatch: null } as never);
});

describe('events:status projection', () => {
  it('opts out of the ambient workspace transaction for concurrent projected reads', () => {
    expect(status.skipWorkspaceTx).toBe(true);
  });

  it('projects await rows to await_id/event/policy/note/expires_ts/on_timeout/created_at', async () => {
    const out = await call({});
    expect(out.active_awaits[0]).toEqual({
      await_id: 11,
      event: 'lock:grant:t1',
      policy: 'wake',
      note: 'n',
      expires_ts: 'E',
      on_timeout: 'wake',
      created_at: 'C',
    });
  });

  it('projects standing event-key inject subscriptions separately from wake awaits', async () => {
    const out = await call({});

    expect(out.active_event_subscriptions).toEqual([
      {
        subscription_id: 33,
        event: 'work-item:claimable',
        delivery: 'inject',
        mode: 'digest',
        expires_ts: null,
        created_at: 'C3',
      },
    ]);
    expect(listMyEventKeySubscriptions).toHaveBeenCalledWith({
      ownerId: 'su-status',
      ownerLabel: 's',
      source: 'static-client',
      workspaceId: 'ws-x',
      userId: null,
    });
  });

  it('accepts the await_id returned by events:await and narrows active_awaits to that registration', async () => {
    vi.mocked(listActiveAwaits).mockResolvedValueOnce([
      AWAIT_ROW,
      { ...AWAIT_ROW, id: 12, eventKey: 'other:event' },
    ] as never);

    const out = await call({ await_id: 12 });

    expect(out.active_awaits).toEqual([
      {
        await_id: 12,
        event: 'other:event',
        policy: 'wake',
        note: 'n',
        expires_ts: 'E',
        on_timeout: 'wake',
        created_at: 'C',
      },
    ]);
  });

  it('rejects combining await_id with exact event inspection', async () => {
    await expect(call({ await_id: 11, event: 'lock:grant:t1' })).rejects.toThrow(/mutually exclusive/);
  });

  it('never projects emitter-side announcement rows as cancellable active awaits', async () => {
    vi.mocked(listActiveAwaits).mockResolvedValueOnce([
      AWAIT_ROW,
      {
        ...AWAIT_ROW,
        id: 12,
        eventKey: 'gate:declared',
        policy: 'announce',
      },
    ] as never);

    const out = await call({});
    expect(out.active_awaits.map((row: { await_id: number }) => row.await_id)).toEqual([11]);
  });

  it('projects delivery rows with derived turn_invoked state, not status alone', async () => {
    const out = await call({});
    expect(out.recent_wakes[0]).toEqual({
      delivery_id: 22,
      event: 'lock:grant:t1',
      status: 'parked',
      channel: 'inbox',
      turn_invoked: false,
      attempts: 2,
      last_error: 'boom',
      created_at: 'C2',
      delivered_at: null,
    });
  });

  it('reports the full outstanding backlog even when recent_wakes hides older live rows', async () => {
    vi.mocked(listRecentDeliveries).mockResolvedValueOnce([{ ...DELIVERY_ROW, id: 30, status: 'delivered' }]);
    vi.mocked(deliveryBacklogSummary).mockResolvedValueOnce({
      total: 134,
      pending: 118,
      parked: 0,
      delivering: 16,
      fromCancelledAwaits: 134,
      oldestCreatedAt: '2026-08-30T04:00:00.000Z',
    });

    const out = await call({});

    expect(out.outstanding_deliveries).toMatchObject({
      total: 134,
      by_status: { pending: 118, parked: 0, delivering: 16 },
      from_cancelled_awaits: 134,
      shown_in_recent_wakes: 0,
      hidden_from_recent_wakes: 134,
    });
    expect(out.outstanding_deliveries.warning).toMatch(/cancelled awaits/);
  });

  it('meter omitted unless meter:true (default call → wakeMeter NOT invoked, no meter key)', async () => {
    const out = await call({});
    expect(wakeMeter).not.toHaveBeenCalled();
    expect('meter' in out).toBe(false);
  });

  it('meter:true → wakeMeter invoked and the meter rides in the envelope', async () => {
    const out = await call({ meter: true });
    // WI-3575: wakeMeter/listActiveAwaits no longer take workspaceId (events:await
    // is single-workspace by design — see store.ts).
    expect(wakeMeter).toHaveBeenCalledWith();
    expect(out.meter).toEqual({ total: 7 });
  });

  it('all ambient store reads run (Promise.all), scoped to identity', async () => {
    await call({ meter: true });
    expect(listActiveAwaits).toHaveBeenCalledWith('su-status');
    expect(listRecentDeliveries).toHaveBeenCalledWith('su-status', 10);
    expect(deliveryBacklogSummary).toHaveBeenCalledWith('su-status');
    expect(listMyEventKeySubscriptions).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-status' }));
    expect(wakeMeter).toHaveBeenCalledTimes(1);
  });

  it('exact-key inspection returns causal generations, evidence, waiters, wakes, and a stale-watermark resync', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [
        {
          id: 2,
          causalGeneration: 2,
          subscriberId: 'su-emitter',
          createdAt: '2026-07-13T12:00:00.000Z',
          note: 'ship exact SHA',
          expectedCondition: { kind: 'sha', sha: 'abcdef1' },
          firedPayload: { deployed_sha: 'abcdef1' },
          firedAt: '2026-07-13T12:05:00.000Z',
          firedReason: 'event',
          firedBy: 'release-host',
          cancelledAt: null,
          supersededAt: null,
        },
        {
          id: 1,
          causalGeneration: 1,
          subscriberId: 'su-emitter',
          createdAt: '2026-07-13T11:00:00.000Z',
          note: 'old gate',
          expectedCondition: null,
          firedPayload: null,
          firedAt: null,
          firedReason: null,
          firedBy: null,
          cancelledAt: null,
          supersededAt: '2026-07-13T12:00:00.000Z',
        },
      ],
      waiters: [{
        id: 31,
        subscriberId: 'su-waiter',
        policy: 'wake',
        createdAt: '2026-07-13T12:01:00.000Z',
        firedAt: '2026-07-13T12:05:00.000Z',
        firedReason: 'event',
        cancelledAt: null,
        expiresTs: null,
      }],
      deliveries: [{
        id: 41,
        subscriberId: 'su-waiter',
        status: 'delivered',
        channel: 'pty-inject',
        attempts: 1,
        source: 'release-host',
        lastError: null,
        createdAt: '2026-07-13T12:05:00.000Z',
        deliveredAt: '2026-07-13T12:05:01.000Z',
      }],
    } as never);

    const out = await call({ event: 'deploy:abcdef1', after_generation: 1 });
    expect(inspectEventKey).toHaveBeenCalledWith('deploy:abcdef1');
    expect(out.event_inspection.current_generation).toBe(2);
    expect(out.event_inspection.current_state).toBe('fired');
    expect(out.event_inspection.declarations).toMatchObject([
      { generation: 2, expected_verdict: 'matched', actual_sha: 'abcdef1', fired_by: 'release-host' },
      { generation: 1, state: 'superseded' },
    ]);
    expect(out.event_inspection.waiters[0]).toMatchObject({ await_id: 31, state: 'fired' });
    expect(out.event_inspection.wake_outcomes[0]).toMatchObject({
      delivery_id: 41,
      status: 'delivered',
      turn_invoked: true,
    });
    expect(out.event_inspection.resync).toMatchObject({
      required: true,
      reason: 'consumer_behind',
      consumer_generation: 1,
      authoritative_generation: 2,
    });
    // Exact-key inspection must not be buried behind this caller's unrelated
    // await tree; callers asking for one event receive the focused authority.
    expect(out).not.toHaveProperty('active_awaits');
    expect(out).not.toHaveProperty('recent_wakes');
    expect(listActiveAwaits).not.toHaveBeenCalled();
    expect(listRecentDeliveries).not.toHaveBeenCalled();
    expect(deliveryBacklogSummary).not.toHaveBeenCalled();
    expect(listMyEventKeySubscriptions).not.toHaveBeenCalled();
  });

  it('maps an expired current declaration to expired and preserves superseded precedence', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [
        {
          id: 3,
          causalGeneration: 3,
          subscriberId: 'su-emitter',
          createdAt: '2026-07-13T12:10:00.000Z',
          note: 'current gate',
          expectedCondition: null,
          firedPayload: null,
          firedAt: '2026-07-13T12:11:00.000Z',
          firedReason: 'expired',
          firedBy: null,
          cancelledAt: null,
          supersededAt: null,
        },
        {
          id: 2,
          causalGeneration: 2,
          subscriberId: 'su-emitter',
          createdAt: '2026-07-13T12:00:00.000Z',
          note: 'superseded gate',
          expectedCondition: null,
          firedPayload: null,
          firedAt: '2026-07-13T12:05:00.000Z',
          firedReason: 'expired',
          firedBy: null,
          cancelledAt: null,
          supersededAt: '2026-07-13T12:10:00.000Z',
        },
      ],
      waiters: [],
      deliveries: [],
      fireLatch: null,
    } as never);

    const out = await call({ event: 'gate:expired' });

    expect(out.event_inspection.current_state).toBe('expired');
    expect(out.event_inspection.declarations).toMatchObject([
      { generation: 3, state: 'expired' },
      { generation: 2, state: 'superseded' },
    ]);
  });

  it('EI-13705: a bare-emitted key with no announcement but a fire latch reports fired_undeclared, not undeclared — with fire_latch + advice surfaced', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [],
      waiters: [],
      deliveries: [],
      fireLatch: {
        workspaceId: 'ws-x',
        eventKey: 'p2p-git:phase3-open',
        firstFiredAt: '2026-07-10T23:17:46.000Z',
        lastFiredAt: '2026-07-10T23:17:46.000Z',
        lastFiredBy: 'su-63834d42',
        lastPayload: null,
        fireCount: 1,
      },
    } as never);

    const out = await call({ event: 'p2p-git:phase3-open' });
    expect(out.event_inspection.current_state).toBe('fired_undeclared');
    expect(out.event_inspection.fire_latch).toEqual({
      first_fired_at: '2026-07-10T23:17:46.000Z',
      last_fired_at: '2026-07-10T23:17:46.000Z',
      last_fired_by: 'su-63834d42',
      fire_count: 1,
    });
    expect(out.event_inspection.advice).toMatch(/genuinely fired/);
    expect(out.event_inspection.advice).toMatch(/never happened/);
  });

  it('a key with no announcement and no fire latch (truly never fired) still reports undeclared', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [],
      waiters: [],
      deliveries: [],
      fireLatch: null,
    } as never);

    const out = await call({ event: 'never:fired' });
    expect(out.event_inspection.current_state).toBe('undeclared');
    expect('fire_latch' in out.event_inspection).toBe(false);
    expect('advice' in out.event_inspection).toBe(false);
  });

  it('an active announcement wins over a stale fire latch (declared/fired states unaffected)', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 2,
        causalGeneration: 2,
        subscriberId: 'su-emitter',
        createdAt: '2026-07-13T12:00:00.000Z',
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: null,
        expectedCondition: null,
        firedPayload: null,
      }],
      waiters: [],
      deliveries: [],
      fireLatch: {
        workspaceId: 'ws-x',
        eventKey: 'deploy:abcdef1',
        firstFiredAt: '2026-07-01T00:00:00.000Z',
        lastFiredAt: '2026-07-01T00:00:00.000Z',
        lastFiredBy: 'old-source',
        lastPayload: null,
        fireCount: 3,
      },
    } as never);
    const out = await call({ event: 'deploy:abcdef1' });
    expect(out.event_inspection.current_state).toBe('declared');
    // fire_latch is still surfaced (informational) even when an announcement governs current_state.
    expect(out.event_inspection.fire_latch).toBeTruthy();
    expect('advice' in out.event_inspection).toBe(false);
  });

  it('an exact current generation is in sync', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 2,
        causalGeneration: 2,
        subscriberId: 'su-emitter',
        createdAt: '2026-07-13T12:00:00.000Z',
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: null,
        expectedCondition: null,
        firedPayload: null,
      }],
      waiters: [],
      deliveries: [],
    } as never);
    const out = await call({ event: 'deploy:abcdef1', after_generation: 2 });
    expect(out.event_inspection.resync).toMatchObject({ required: false, reason: 'in_sync' });
  });

  it('projects durable owner binding, ended declarer, and a live role successor', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 9,
        causalGeneration: 3,
        subscriberId: 'su-ended',
        boundTo: { kind: 'role', ref: 'release-fixer' },
        createdAt: '2026-07-13T12:00:00.000Z',
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: null,
        expectedCondition: null,
        firedPayload: null,
      }],
      waiters: [],
      deliveries: [],
    } as never);
    vi.mocked(resolveLiveRoleHolders).mockResolvedValueOnce(['su-successor']);
    vi.mocked(resolveSessionStates).mockResolvedValueOnce(new Map([
      ['su-ended', { ownerId: 'su-ended', sessionState: 'ended' }],
      ['su-successor', { ownerId: 'su-successor', sessionState: 'parked' }],
    ]) as never);

    const out = await call({ event: 'gate:role-owner' });
    expect(resolveLiveRoleHolders).toHaveBeenCalledWith('release-fixer', { workspaceId: 'ws-x' });
    expect(resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'su-ended' }, { ownerId: 'su-successor' }],
      { hydratePerId: true },
    );
    expect(out.event_inspection.declarations[0]).toMatchObject({
      bound_to: { kind: 'role', ref: 'release-fixer' },
      declared_by_liveness: 'ended',
      live_successor_ids: ['su-successor'],
    });
    expect(out.event_inspection.declarations[0]).not.toHaveProperty('stale_owner');
  });

  it('marks an active announcement stale only when its ended owner has no live successor', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 10,
        causalGeneration: 4,
        subscriberId: 'su-ended',
        boundTo: { kind: 'fleet-leadership', ref: 'fleet-a' },
        createdAt: '2026-07-13T12:00:00.000Z',
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: null,
        expectedCondition: null,
        firedPayload: null,
      }],
      waiters: [],
      deliveries: [],
    } as never);
    vi.mocked(hostAudienceResolvers.listFleetLeader).mockResolvedValueOnce(['su-ended']);
    vi.mocked(resolveSessionStates).mockResolvedValueOnce(new Map([
      ['su-ended', { ownerId: 'su-ended', sessionState: 'ended' }],
    ]) as never);

    const out = await call({ event: 'gate:fleet-owner' });
    expect(out.event_inspection.declarations[0]).toMatchObject({
      bound_to: { kind: 'fleet-leadership', ref: 'fleet-a' },
      declared_by_liveness: 'ended',
      live_successor_ids: [],
      stale_owner: true,
    });
  });
});

/**
 * EI-22075989127611832 — `await_id` × `event` exclusivity is enforced in the HANDLER,
 * so it was invisible to a caller reading the published arg schema: two plain optionals
 * with no declared constraint. The filed report read that rejection as the tool refusing
 * a documented argument, because the only way to discover the rule was to trip it.
 *
 * Pin the DECLARATION to the ENFORCEMENT so they cannot drift apart again: drop the
 * handler guard and the second test fails; drop the description and the first does.
 */
describe('events:status — await_id/event exclusivity is declared, not only enforced', () => {
  const shape = (status.args as unknown as {
    shape: Record<string, { description?: string }>;
  }).shape;

  it('declares the mutual exclusion on both args, each naming its counterpart', () => {
    expect(shape.await_id.description).toMatch(/mutually exclusive/i);
    expect(shape.await_id.description).toContain('event');
    expect(shape.event.description).toMatch(/mutually exclusive/i);
    expect(shape.event.description).toContain('await_id');
  });

  it('still refuses the combination at the handler', async () => {
    await expect(call({ await_id: 11, event: 'lock:grant:t1' }))
      .rejects.toThrow(/mutually exclusive/i);
  });
});
