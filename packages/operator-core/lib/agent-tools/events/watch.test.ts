/**
 * watch.test.ts — the unified `watch` primitive's routing (unify-watch-primitive P-007).
 * Deps mocked; asserts wake:false → inject/subscribe path, wake:true → the await registration
 * with the right cardinality + floor defaults.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'documenter', 'curator'],
  lookupByMcpName: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-watcher', ownerLabel: 'w', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' })),
}));
vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({ id: 1, eventKey: i.eventKey, once: i.once, minSleepSec: i.minSleepSec, urgency: i.urgency, expiresTs: null, timeoutBehavior: i.timeoutBehavior })),
  cancelAwait: vi.fn(async () => true),
}));
vi.mock('../../events/await/engine', () => ({
  startAwaitSweeper: vi.fn(),
  deliverToSpecificAwaits: vi.fn(async (i: { awaitRows: Array<{ id: number }> }) => ({ delivered: i.awaitRows.length })),
}));
// P-008: the predicate engine is its own tested module (predicate-watch.test.ts /
// .integration.test.ts) — here only the tool's ROUTING into it is under test.
vi.mock('../../events/await/predicate-watch', () => ({
  PREDICATE_OPS: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'],
  registerPredicateWatch: vi.fn(async (i: Record<string, unknown>) => ({ ...i, intervalSec: i.intervalSec ?? 60, lastEval: null, active: true })),
  startPredicateWatchPoller: vi.fn(),
  evalPredicateWatch: vi.fn(async () => ({ fired: false, matched: false, deactivated: false })),
  // P-004 dedup: default no match — the individual dedup tests below override this.
  findMatchingActivePredicateWatch: vi.fn(async () => null),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-x' }));
vi.mock('../coordination/topics', () => ({ subscribeTopic: vi.fn(async (_id: unknown, slug: string, opts: Record<string, unknown>) => ({ target_ref: slug, delivery_mode: opts.mode ?? 'full', expires_ts: null })) }));
// WI-4014 Part 2: the targetKind:'event' sibling of subscribeTopic above.
vi.mock('../coordination/event-subscriptions', () => ({ subscribeEventKey: vi.fn(async (_id: unknown, key: string, opts: Record<string, unknown>) => ({ target_ref: key, delivery_mode: opts.mode ?? 'full', expires_ts: null })) }));

import watch from './watch';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { registerAwait, cancelAwait } from '../../events/await/store';
import { deliverToSpecificAwaits } from '../../events/await/engine';
import { registerPredicateWatch, evalPredicateWatch, findMatchingActivePredicateWatch } from '../../events/await/predicate-watch';
import { subscribeTopic } from '../coordination/topics';
import { subscribeEventKey } from '../coordination/event-subscriptions';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof watch.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await watch.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('watch routing', () => {
  it('wake:false (default) → inject path: a standing topic subscription, no await', async () => {
    const out = await call({ pattern: 'locks', mode: 'digest', timeout_sec: 99 });
    expect(subscribeTopic).toHaveBeenCalledWith(expect.anything(), 'locks', { mode: 'digest', ttl_sec: 99 });
    expect(registerAwait).not.toHaveBeenCalled();
    expect(out.watch).toMatchObject({ wake: false, once: false, mode: 'digest' });
  });

  it('wake:true (default once) → a one-shot wake grant, no floor', async () => {
    const out = await call({ pattern: 'lock:grant:t1', wake: true });
    expect(subscribeTopic).not.toHaveBeenCalled();
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ eventKey: 'lock:grant:t1', policy: 'wake', once: true, minSleepSec: 0 });
    expect(out.watch).toMatchObject({ wake: true, once: true, min_sleep_sec: 0 });
  });

  it('wake:true once:false → a STANDING wake watch defaulting to the floor', async () => {
    await call({ pattern: 'feature:settled', wake: true, once: false });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ once: false, minSleepSec: 60 }); // standing floor default
    expect(arg.timeoutSec).toBeNull(); // standing watches have no default deadline
  });

  it('min_sleep_sec + urgency are honored on a standing wake watch', async () => {
    await call({ pattern: 'hot:key', wake: true, once: false, min_sleep_sec: 120, urgency: true });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ minSleepSec: 120, urgency: true });
  });

  it('EI-8998: payload_filter on a wake watch is threaded through to registerAwait', async () => {
    const filter = { queue_depth: { lt: 5 } };
    await call({ pattern: 'queue:depth-changed', wake: true, payload_filter: filter });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ payloadFilter: filter });
  });

  it('EI-8998: payload_filter on an inject (wake:false) watch is rejected loudly, not silently ignored', async () => {
    await expect(call({ pattern: 'locks', payload_filter: { x: 1 } })).rejects.toThrow(/payload_filter/);
    expect(subscribeTopic).not.toHaveBeenCalled();
  });
});

describe('WI-4014 Part 2: targetKind routing (wake:false only)', () => {
  it('targetKind omitted defaults to "topic" (unchanged, backward compatible)', async () => {
    const out = await call({ pattern: 'locks' });
    expect(subscribeTopic).toHaveBeenCalledWith(expect.anything(), 'locks', { mode: undefined, ttl_sec: undefined });
    expect(subscribeEventKey).not.toHaveBeenCalled();
    expect(out.watch).toMatchObject({ targetKind: 'topic' });
  });

  it('targetKind:"event" routes to subscribeEventKey, NOT subscribeTopic', async () => {
    const out = await call({ pattern: 'lock:grant:t1', targetKind: 'event', mode: 'digest', timeout_sec: 42 });
    expect(subscribeEventKey).toHaveBeenCalledWith(expect.anything(), 'lock:grant:t1', { mode: 'digest', ttl_sec: 42 });
    expect(subscribeTopic).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
    expect(out.watch).toMatchObject({ pattern: 'lock:grant:t1', targetKind: 'event', wake: false, once: false, mode: 'digest' });
  });

  it('targetKind:"event" is ignored on a wake:true watch (only wake:false honors it)', async () => {
    await call({ pattern: 'feature:settled', targetKind: 'event', wake: true });
    expect(subscribeEventKey).not.toHaveBeenCalled();
    expect(subscribeTopic).not.toHaveBeenCalled();
    expect(registerAwait).toHaveBeenCalled();
  });
});

describe('P-008 predicate watch routing', () => {
  const predicate = { tool: 'work_items:list', path: 'counts.open', op: 'gt', value: 5 };

  it('predicate on wake:false is rejected loudly', async () => {
    await expect(call({ pattern: 'backlog', predicate })).rejects.toThrow(/wake:true/);
    expect(subscribeTopic).not.toHaveBeenCalled();
  });

  it('interval_sec without a predicate is rejected (min_sleep_sec confusion guard)', async () => {
    await expect(call({ pattern: 'k', wake: true, interval_sec: 30 })).rejects.toThrow(/interval_sec/);
  });

  it('a non-read tool is refused before anything registers', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'write' } as never);
    await expect(call({ pattern: 'backlog', wake: true, predicate })).rejects.toThrow(/read-only/);
    expect(registerAwait).not.toHaveBeenCalled();
    expect(registerPredicateWatch).not.toHaveBeenCalled();
  });

  it('happy path: await registers FIRST on the synthetic key, then the watch row, then ONE inline eval', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as never);
    const out = await call({ pattern: 'open backlog high', wake: true, predicate, interval_sec: 30 });
    const awaitArg = vi.mocked(registerAwait).mock.calls[0][0] as Record<string, unknown>;
    expect(String(awaitArg.eventKey)).toMatch(/^predicate:[0-9a-f-]{36}$/);
    const rowArg = vi.mocked(registerPredicateWatch).mock.calls[0][0] as Record<string, unknown>;
    expect(rowArg).toMatchObject({ eventKey: awaitArg.eventKey, tool: 'work_items:list', op: 'gt', intervalSec: 30, role: 'su' });
    // Order: the await must exist before the row (GC invariant).
    expect(vi.mocked(registerAwait).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(registerPredicateWatch).mock.invocationCallOrder[0],
    );
    expect(evalPredicateWatch).toHaveBeenCalledTimes(1);
    expect(out.predicate).toMatchObject({ tool: 'work_items:list', op: 'gt', interval_sec: 30 });
    expect(out.first_eval).toMatchObject({ matched: false, fired: false });
    expect(out.watch.label).toBe('open backlog high');
  });

  it('an inline first-eval ERROR unwinds the await and throws (no dangling waiter)', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as never);
    vi.mocked(evalPredicateWatch).mockResolvedValueOnce({ fired: false, matched: false, deactivated: false, error: 'role gate: denied' } as never);
    await expect(call({ pattern: 'b', wake: true, predicate })).rejects.toThrow(/inline first eval.*role gate/s);
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 1, subscriberId: 'su-watcher' });
  });
});

describe('P-004 predicate watch dedupe (EI-8998)', () => {
  const predicate = { tool: 'work_items:list', path: 'counts.open', op: 'gt', value: 5 };
  const existingRow = {
    id: 'watch-existing-1',
    eventKey: 'predicate:existing-1',
    intervalSec: 30,
    lastEval: false,
    lastValue: 3,
  };

  it('an identical active predicate JOINS the existing poller — no new row, no inline eval', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as never);
    vi.mocked(findMatchingActivePredicateWatch).mockResolvedValueOnce(existingRow as never);
    const out = await call({ pattern: 'open backlog high', wake: true, predicate, interval_sec: 30 });

    expect(registerPredicateWatch).not.toHaveBeenCalled();
    expect(evalPredicateWatch).not.toHaveBeenCalled();
    const awaitArg = vi.mocked(registerAwait).mock.calls[0][0] as Record<string, unknown>;
    expect(awaitArg.eventKey).toBe('predicate:existing-1');
    expect(out.deduped).toMatchObject({ joined_watch_id: 'watch-existing-1' });
    expect(out.watch.pattern).toBe('predicate:existing-1');
    expect(out.first_eval).toMatchObject({ matched: false, fired: false });
    expect(deliverToSpecificAwaits).not.toHaveBeenCalled();
  });

  it('joining a row that is ALREADY true fires the new subscriber immediately, without a key-wide emit', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as never);
    vi.mocked(findMatchingActivePredicateWatch).mockResolvedValueOnce({ ...existingRow, lastEval: true, lastValue: 9 } as never);
    const out = await call({ pattern: 'open backlog high', wake: true, predicate, interval_sec: 30 });

    expect(deliverToSpecificAwaits).toHaveBeenCalledTimes(1);
    const deliverArg = vi.mocked(deliverToSpecificAwaits).mock.calls[0][0];
    expect(deliverArg.awaitRows).toHaveLength(1);
    expect(out.first_eval).toMatchObject({ matched: true, fired: true, observed: 9 });
    expect(out.deduped).toMatchObject({ joined_watch_id: 'watch-existing-1' });
  });

  it('the dedup lookup is scoped by workspace/role/harness/tool/args/path/op/value/interval/once', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as never);
    await call({ pattern: 'open backlog high', wake: true, predicate, interval_sec: 30 });
    expect(findMatchingActivePredicateWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-x',
        role: 'su',
        tool: 'work_items:list',
        path: 'counts.open',
        op: 'gt',
        value: 5,
        intervalSec: 30,
        once: true,
      }),
    );
  });
});
