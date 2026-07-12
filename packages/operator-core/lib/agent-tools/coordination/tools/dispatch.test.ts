/**
 * dispatch.test.ts — coord:dispatch's pure composition (fleet-dispatch-wake-clarity
 * P-002 / D-002). The in-process `call` is mocked (we assert WHICH sub-tools run with
 * WHAT args + how their results fold into the dispatch report), so no PG / no live pump.
 */
import { describe, it, expect, vi } from 'vitest';
import { composeDispatch, type DispatchArgs } from './dispatch';
import type { HydratableRef, HydratedRef } from '../ref-hydrate';
import type { RefResolvers } from '../ref-hydrate-resolve';

// WI-4165 item-body hydration touches the real PG-backed plan store
// (getPlanRow) when no `deps.hydrateRefs` override is injected. Mock it at
// the module boundary so the pre-existing tests below (which pass no deps,
// exercising the REAL default hydrateRefs) stay DB-free and deterministic —
// a plan-item ref simply resolves to "not found", degrading to the plain
// note exactly like a resolve_error would (fail-soft, same as prod).
vi.mock('../../plans/source', () => ({
  getPlanRow: vi.fn(async () => null),
  planItemsForRow: vi.fn(() => []),
}));

/** A mock InnerCall: records every (name,args) and returns a per-tool canned reply. */
function mockCall(replies: Record<string, unknown | ((args: any) => unknown)>) {
  const calls: Array<{ name: string; args: any }> = [];
  const call = vi.fn(async (name: string, args: unknown) => {
    calls.push({ name, args });
    const r = replies[name];
    if (r === undefined) throw new Error(`unexpected sub-call ${name}`);
    return typeof r === 'function' ? (r as (a: any) => unknown)(args) : r;
  });
  return { call: call as unknown as (name: string, args: unknown) => Promise<unknown>, calls };
}

/** A coord:send envelope with one result carrying the given wake fields. */
const sendEnv = (to: string, wake: Record<string, unknown>, msg_id = 'm-1') => ({
  ok: true,
  results: [{ ok: true, to: [to], msg_id, ts: 't', wake }],
  counts: { ok: 1, failed: 0 },
});

const presence = (rows: Array<Record<string, unknown>>) => ({ active: rows, summary: {} });

const baseArgs: DispatchArgs = {
  to: 'su-7a2a',
  note: 'take fleet-dispatch P-001..P-004',
  planSlug: 'fleet-dispatch-wake-clarity-2026-06-22',
  items: ['P-001', 'P-002'],
};

describe('composeDispatch', () => {
  it('full dispatch to a PARKED target: assigns lane + delivers note + wakes, reports pickup', async () => {
    const { call, calls } = mockCall({
      'coord:presence': presence([
        { ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true },
      ]),
      'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
      'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
    });
    const res = await composeDispatch(baseArgs, call);

    // all three legs ran, in order
    expect(calls.map((c) => c.name)).toEqual(['coord:presence', 'plan_items:assign', 'coord:send']);
    // the lane assign carried the plan + items + assignee
    expect(calls[1].args).toMatchObject({
      plan: baseArgs.planSlug,
      itemIds: ['P-001', 'P-002'],
      assignee: 'su-7a2a',
    });
    // the send opted into the REQUIRED wake on the single target
    expect(calls[2].args).toMatchObject({ to: ['su-7a2a'], summary: baseArgs.note, wake: 'required' });

    expect(res.ok).toBe(true);
    expect(res.to).toBe('su-7a2aFULL'); // resolved ownerId from the send result
    expect(res.sessionState).toBe('parked');
    expect(res.wakeable).toBe(true);
    expect(res.assigned).toMatchObject({ ok: true, planSlug: baseArgs.planSlug, items: ['P-001', 'P-002'] });
    expect(res.delivered).toBe('m-1');
    expect(res.woken).toBe(1);
    expect(res.warning).toBeUndefined();
    expect(res.recipient_absent).toBeUndefined();
  });

  it('dispatch to an ENDED target is a LOUD miss — lane assigned, but warning + recipient_dead', async () => {
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-dead', sessionState: 'ended', wakeable: false }]),
      'plan_items:assign': { ok: true, results: [{ ok: true }] },
      'coord:send': sendEnv('su-dead', {
        mode: 'required',
        targets: ['su-dead'],
        woken: 0,
        recipient_absent: true,
        recipient_dead: ['su-dead'],
      }),
    });
    const res = await composeDispatch({ ...baseArgs, to: 'su-dead', items: ['P-001'] }, call);

    expect(res.sessionState).toBe('ended');
    expect(res.woken).toBe(0);
    expect(res.recipient_dead).toEqual(['su-dead']);
    expect(res.assigned?.ok).toBe(true); // the durable lane still landed
    expect(res.warning).toMatch(/RELAUNCH|relaunch/);
    expect(res.warning).toMatch(/no LIVE session/i);
  });

  it('pure directed wake (no planSlug/items) skips plan_items:assign entirely', async () => {
    const { call, calls } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
      'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
    });
    const res = await composeDispatch(
      { to: 'su-7a2a', note: 'resume what I sent you' },
      call,
    );
    expect(calls.map((c) => c.name)).toEqual(['coord:presence', 'coord:send']); // NO assign
    expect(res.assigned).toBeNull();
    expect(res.woken).toBe(1);
    expect(res.delivered).toBe('m-1');
  });

  it('degrades when the presence read fails — sessionState null, dispatch still runs', async () => {
    const { call, calls } = mockCall({
      'coord:presence': () => {
        throw new Error('presence down');
      },
      'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
      'coord:send': sendEnv('su-7a2a', { mode: 'required', targets: ['su-7a2a'], woken: 1 }),
    });
    const res = await composeDispatch(baseArgs, call);
    expect(res.sessionState).toBeNull();
    expect(res.wakeable).toBeNull();
    expect(res.woken).toBe(1); // the wake still fired
    expect(calls.map((c) => c.name)).toContain('coord:send');
  });

  it('a failed assign leg does NOT swallow the wake — assigned.ok false + error, send still runs', async () => {
    const { call, calls } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
      'plan_items:assign': () => {
        throw new Error('cross-user refused');
      },
      'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
    });
    const res = await composeDispatch(baseArgs, call);
    expect(res.assigned?.ok).toBe(false);
    expect(res.assigned?.error).toMatch(/cross-user/);
    expect(res.woken).toBe(1); // the critical leg still ran
    expect(calls.map((c) => c.name)).toContain('coord:send');
  });

  it('EI-5957: a MANUAL-mode target (staged, woken 0) gets the LOUD "STAGED not delivered" warning', async () => {
    // The member is ALIVE (parked) but in manual wake-mode, so coord:send stages
    // the directed note instead of delivering it: woken:0, staged:1, NOT dead/absent.
    // Before the fix this produced NO warning (a quiet staged read as delivered).
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-manual', sessionState: 'parked', wakeable: true }]),
      'plan_items:assign': { ok: true, results: [{ ok: true }] },
      'coord:send': sendEnv('su-manual', {
        mode: 'required',
        targets: ['su-manual'],
        woken: 0,
        staged: 1,
        stagedTargets: ['su-manual'],
        note: 'wake STAGED, NOT delivered for su-manual: target(s) are in MANUAL wake-mode …',
      }),
    });
    const res = await composeDispatch({ ...baseArgs, to: 'su-manual', items: ['P-001'] }, call);
    expect(res.woken).toBe(0);
    expect(res.staged).toBe(1);
    expect(res.recipient_dead).toBeUndefined();
    expect(res.recipient_absent).toBeUndefined();
    expect(res.assigned?.ok).toBe(true); // the durable lane still landed
    expect(res.warning).toMatch(/STAGED/);
    expect(res.warning).toMatch(/MANUAL wake-mode/);
    expect(res.warning).toMatch(/wake-queue|wake-mode/);
  });

  it('a live-but-paused target (woken 0, not dead) gets the softer "confirm pickup" warning', async () => {
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-paused', sessionState: 'parked', wakeable: true }]),
      'plan_items:assign': { ok: true, results: [{ ok: true }] },
      'coord:send': sendEnv('su-paused', {
        mode: 'required',
        targets: ['su-paused'],
        woken: 0,
        recipient_absent: true,
      }),
    });
    const res = await composeDispatch({ ...baseArgs, to: 'su-paused', items: ['P-001'] }, call);
    expect(res.recipient_absent).toBe(true);
    expect(res.recipient_dead).toBeUndefined();
    expect(res.warning).toMatch(/confirm pickup/i);
  });

  describe('WI-4165: assigned plan-item body hydration', () => {
    const hydratedRef = (item: string, snippet: string): HydratedRef => ({
      ref: { kind: 'plan-item', slug: baseArgs.planSlug as string, item },
      ok: true,
      label: `plan:${baseArgs.planSlug}#${item} [todo]`,
      snippet,
    });

    it('inlines each assigned item\'s hydrated body into the delivered note', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(
        async (_refs: HydratableRef[], _opts?: { resolvers?: RefResolvers }): Promise<HydratedRef[]> => [
          hydratedRef('P-001', 'Wire the DHT bootstrap fixture.'),
          hydratedRef('P-002', 'Verify the cold-join path.'),
        ],
      );
      const res = await composeDispatch(baseArgs, call, { hydrateRefs });

      // the resolver was scoped by the module's own budget/consumer contract —
      // one ref per assigned item, in order, no harness override (baseArgs has none)
      expect(hydrateRefs).toHaveBeenCalledTimes(1);
      const [refsArg] = hydrateRefs.mock.calls[0];
      expect(refsArg).toEqual([
        { kind: 'plan-item', slug: baseArgs.planSlug, item: 'P-001' },
        { kind: 'plan-item', slug: baseArgs.planSlug, item: 'P-002' },
      ]);

      const sendArgs = calls[calls.length - 1].args as { body?: string };
      expect(sendArgs.body).toContain('Wire the DHT bootstrap fixture.');
      expect(sendArgs.body).toContain('Verify the cold-join path.');
      expect(sendArgs.body).toContain('P-001');
      expect(sendArgs.body).toContain('P-002');
      expect(res.itemsHydrated).toBe(2);
    });

    it('prepends an explicit args.body before the hydrated item bodies', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(async () => [hydratedRef('P-001', 'Wire the DHT bootstrap fixture.')]);
      await composeDispatch({ ...baseArgs, body: 'extra context up top' }, call, { hydrateRefs });

      const sendArgs = calls[calls.length - 1].args as { body?: string };
      expect(sendArgs.body?.indexOf('extra context up top')).toBeLessThan(
        sendArgs.body?.indexOf('Wire the DHT bootstrap fixture.') ?? -1,
      );
    });

    it('fail-soft: a hydrate error still delivers the plain note (no body added, wake unaffected)', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(async () => {
        throw new Error('plan store down');
      });
      const res = await composeDispatch(baseArgs, call, { hydrateRefs });

      const sendArgs = calls[calls.length - 1].args as { body?: string };
      expect(sendArgs.body).toBeUndefined();
      expect(res.itemsHydrated).toBeUndefined();
      expect(res.woken).toBe(1); // the critical leg is unaffected by the hydration failure
    });

    it('skips hydration entirely for a pure directed wake (no planSlug/items)', async () => {
      const { call } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(async () => []);
      await composeDispatch({ to: 'su-7a2a', note: 'resume what I sent you' }, call, { hydrateRefs });
      expect(hydrateRefs).not.toHaveBeenCalled();
    });
  });
});
