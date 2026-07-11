/**
 * compose-toolsurface.test.ts — the events tool-surface additions for composed
 * threshold-tree awaits (composable-event-awaits-2026-07-11 P-004).
 *
 * A handler-level SMOKE test (the store/compose layer is unit-tested in
 * compose-spec.test.ts and integration-tested against a real PG in
 * compose.integration.test.ts). This asserts only the TOOL WRAPPER contract that
 * those layers don't see:
 *   - events:await `spec` XOR `event` (schema refine), the composed happy-path
 *     response shape, the already_satisfied short-circuit, and that a
 *     ComposedSpecError is caught into { ok:false } instead of escaping as a 500;
 *   - events:cancel root_id → cancelComposedTree (+ the miss → ok:false rule);
 *   - events:status renders composed_awaits AND filters composed rows (rootId set)
 *     out of the plain active_awaits list.
 *
 * Mirrors the tool-mock rig of await.test.ts / cancel.test.ts / status.test.ts:
 * defineTool is stubbed to identity so `tool.args` is the raw zod schema and
 * `tool.handler` is callable directly. compose-spec is NOT mocked — the real
 * ComposedSpecError is needed so the handler's `instanceof` branch fires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-compose', ownerLabel: 'c', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' })),
}));
vi.mock('../../events/await/engine', () => ({ startAwaitSweeper: vi.fn() }));
// One comprehensive store mock covering everything the three handlers import.
vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(),
  findAnnouncementsForKey: vi.fn(async () => []),
  findNearMissKeys: vi.fn(async () => []),
  cancelAwait: vi.fn(),
  ackDelivery: vi.fn(),
  listActiveAwaits: vi.fn(async () => []),
  listRecentDeliveries: vi.fn(async () => []),
  wakeMeter: vi.fn(),
}));
vi.mock('../../events/await/compose', () => ({ registerComposedAwait: vi.fn() }));
vi.mock('../../events/await/compose-store', () => ({
  cancelComposedTree: vi.fn(),
  listActiveComposedRoots: vi.fn(async () => []),
  loadTreeLeaves: vi.fn(async () => []),
}));

import awaitTool from './await';
import cancel from './cancel';
import status from './status';
import { registerAwait, listActiveAwaits, listRecentDeliveries } from '../../events/await/store';
import { registerComposedAwait } from '../../events/await/compose';
import { cancelComposedTree, listActiveComposedRoots, loadTreeLeaves } from '../../events/await/compose-store';
import { startAwaitSweeper } from '../../events/await/engine';
import { ComposedSpecError } from '../../events/await/compose-spec';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof awaitTool.handler>[1];
const callAwait = async (args: Record<string, unknown>) => {
  const res = (await awaitTool.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};
const callCancel = async (args: Record<string, unknown>) => {
  const res = (await cancel.handler(args as never, ctx)) as { data?: any; content?: Array<{ text: string }> };
  return res.data ?? JSON.parse(res.content![0].text);
};
const callStatus = async (args: Record<string, unknown>) => {
  const res = (await status.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

const ANY_SPEC = { any: [{ event: 'deploy:done' }, { all: [{ event: 'ci:green' }, { event: 'review:approved' }] }] };

beforeEach(() => vi.clearAllMocks());

// ── events:await — the `spec` composed-tree path ──────────────────────────────
describe('events:await spec (composed threshold tree)', () => {
  it('schema refine: exactly one of event / spec (both → reject, neither → reject, either alone → ok)', () => {
    // The XOR lives on the zod refine, which handler(...) bypasses — assert it on the schema.
    expect(awaitTool.args.safeParse({ event: 'k', spec: ANY_SPEC }).success).toBe(false);
    expect(awaitTool.args.safeParse({}).success).toBe(false);
    expect(awaitTool.args.safeParse({ event: 'k' }).success).toBe(true);
    expect(awaitTool.args.safeParse({ spec: ANY_SPEC }).success).toBe(true);
  });

  it('registers via registerComposedAwait (NOT the plain registerAwait) with the wake handle + defaults', async () => {
    vi.mocked(registerComposedAwait).mockResolvedValue({ registered: true, rootId: 55, anchorAwaitId: 777, leafCount: 3, depth: 2 } as never);
    const out = await callAwait({ spec: ANY_SPEC });
    expect(startAwaitSweeper).toHaveBeenCalledTimes(1);
    expect(registerAwait).not.toHaveBeenCalled();
    expect(vi.mocked(registerComposedAwait).mock.calls[0][0]).toMatchObject({
      subscriberId: 'su-compose',
      spec: ANY_SPEC,
      timeoutBehavior: 'wake',
      timeoutSec: null,
      note: null,
    });
    expect(vi.mocked(registerComposedAwait).mock.calls[0][0].wakeHandle).toMatchObject({ kind: 'adv-session' });
    expect(out).toMatchObject({
      ok: true,
      composed: true,
      root_id: 55,
      await_id: 777,
      leaf_count: 3,
      depth: 2,
      on_timeout: 'wake',
      wake_handle: 'resumable',
    });
  });

  it('timeout_sec / on_timeout flow through to registerComposedAwait and the response', async () => {
    vi.mocked(registerComposedAwait).mockResolvedValue({ registered: true, rootId: 1, anchorAwaitId: 2, leafCount: 2, depth: 1 } as never);
    const out = await callAwait({ spec: ANY_SPEC, timeout_sec: 900, on_timeout: 'expire', note: 'why' });
    expect(vi.mocked(registerComposedAwait).mock.calls[0][0]).toMatchObject({ timeoutSec: 900, timeoutBehavior: 'expire', note: 'why' });
    expect(out.on_timeout).toBe('expire');
  });

  it('already-satisfied tree short-circuits to already_satisfied WITHOUT registering', async () => {
    vi.mocked(registerComposedAwait).mockResolvedValue({ registered: false, fired: ['deploy:done'] } as never);
    const out = await callAwait({ spec: ANY_SPEC });
    expect(out).toMatchObject({ ok: true, already_satisfied: true, fired: ['deploy:done'] });
    expect(out.advice).toContain('ALREADY');
    expect(out.composed).toBeUndefined();
  });

  it('an invalid spec (ComposedSpecError) is caught into { ok:false, error } — never escapes as a throw/500', async () => {
    vi.mocked(registerComposedAwait).mockRejectedValue(new ComposedSpecError('composed spec too deep (max 3)'));
    const out = await callAwait({ spec: { all: [] } });
    expect(out).toMatchObject({ ok: false, error: 'composed spec too deep (max 3)' });
    expect(out.advice).toContain('invalid');
  });

  it('a NON-ComposedSpecError still propagates (only the caller-facing validation error is swallowed)', async () => {
    vi.mocked(registerComposedAwait).mockRejectedValue(new Error('db exploded'));
    await expect(callAwait({ spec: ANY_SPEC })).rejects.toThrow(/db exploded/);
  });
});

// ── events:cancel — the root_id tree-cancel path ──────────────────────────────
describe('events:cancel root_id (composed tree)', () => {
  it('root_id → cancelComposedTree({ rootId, subscriberId }); success → ok:true, cancelled:true', async () => {
    vi.mocked(cancelComposedTree).mockResolvedValue(true);
    const out = await callCancel({ root_id: 55 });
    expect(cancelComposedTree).toHaveBeenCalledWith({ rootId: 55, subscriberId: 'su-compose' });
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true, root_id: 55, cancelled: true }] });
    expect(out.results[0].error).toBeUndefined();
  });

  it('root_id miss → ok:false + the not_found reason', async () => {
    vi.mocked(cancelComposedTree).mockResolvedValue(false);
    const out = await callCancel({ root_id: 55 });
    expect(out).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 }, results: [{ ok: false, root_id: 55, cancelled: false, error: 'not_found_or_not_yours_or_already_settled' }] });
  });

  it('root_ids batch → one cancelComposedTree per tree, keyed by root_id', async () => {
    vi.mocked(cancelComposedTree).mockResolvedValue(true);
    const out = await callCancel({ root_ids: [55, 56] });
    expect(cancelComposedTree).toHaveBeenCalledTimes(2);
    expect(out.counts).toEqual({ ok: 2, failed: 0 });
    expect(out.results.map((r: any) => r.root_id)).toEqual([55, 56]);
  });
});

// ── events:status — composed_awaits render + active_awaits filter ──────────────
describe('events:status composed render', () => {
  const PLAIN_AWAIT = { id: 11, eventKey: 'lock:grant:t1', policy: 'wake', note: null, expiresTs: 'E', timeoutBehavior: 'wake', createdAt: 'C', rootId: null };
  const ANCHOR_AWAIT = { id: 12, eventKey: 'composed-root:55', policy: 'wake', note: null, expiresTs: 'E', timeoutBehavior: 'wake', createdAt: 'C', rootId: 55 };
  const ROOT = { id: 55, spec: ANY_SPEC, requiredCount: 1, firedCount: 0, expiresTs: 'E', timeoutBehavior: 'wake', note: 'gate' };

  it('renders composed_awaits and FILTERS composed rows (rootId set) out of active_awaits', async () => {
    vi.mocked(listActiveAwaits).mockResolvedValue([PLAIN_AWAIT, ANCHOR_AWAIT] as never);
    vi.mocked(listRecentDeliveries).mockResolvedValue([] as never);
    vi.mocked(listActiveComposedRoots).mockResolvedValue([ROOT] as never);
    vi.mocked(loadTreeLeaves).mockResolvedValue([
      { eventKey: 'deploy:done', memberFiredAt: null },
      { eventKey: 'ci:green', memberFiredAt: '2026-07-11T00:00:00Z' },
    ] as never);

    const out = await callStatus({});
    // the plain await stays; the composed anchor (rootId 55) is filtered out
    expect(out.active_awaits.map((a: any) => a.await_id)).toEqual([11]);
    // the tree renders under composed_awaits with per-leaf fired state
    expect(listActiveComposedRoots).toHaveBeenCalledWith('su-compose');
    expect(loadTreeLeaves).toHaveBeenCalledWith(55);
    expect(out.composed_awaits).toHaveLength(1);
    expect(out.composed_awaits[0]).toMatchObject({
      root_id: 55,
      spec: ANY_SPEC,
      required: 1,
      fired_count: 0,
      on_timeout: 'wake',
      note: 'gate',
      leaves: [
        { event: 'deploy:done', fired: false, member_fired_at: null },
        { event: 'ci:green', fired: true, member_fired_at: '2026-07-11T00:00:00Z' },
      ],
    });
  });

  it('no composed roots → the composed_awaits key is omitted entirely', async () => {
    vi.mocked(listActiveAwaits).mockResolvedValue([PLAIN_AWAIT] as never);
    vi.mocked(listRecentDeliveries).mockResolvedValue([] as never);
    vi.mocked(listActiveComposedRoots).mockResolvedValue([] as never);
    const out = await callStatus({});
    expect('composed_awaits' in out).toBe(false);
    expect(out.active_awaits.map((a: any) => a.await_id)).toEqual([11]);
  });
});
