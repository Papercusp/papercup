/**
 * set_priority.test.ts — the work_items:set_priority HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). The store (getWorkItemPriority /
 * setWorkItemPriority / bumpWorkItemPriority) and the P-114 arm tripwire
 * (planWorkItemArm / commitWorkItemArm) are mocked. Pins, per item:
 *   • read mode (no directive) → getWorkItemPriority, NO arming, NO write;
 *   • set mode ({ priority }) → setWorkItemPriority, mode:'set', arm COMMITTED when it lands;
 *   • clear ({ priority:null }) → action:'clear';
 *   • bump ({ position }) → bumpWorkItemPriority, mode:'bump';
 *   • not-found → { ok:false, workItem, error } (fails only itself);
 *   • a steering-lease proposal (set.proposed) → proposed:true, arm NOT committed;
 *   • items:[…] → per-item results keyed by workItem, per-item harness honoured;
 *   • the single call is n=1 of the bulk envelope (read results[0]).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/set_priority.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({
  getWorkItemPriority: vi.fn(),
  setWorkItemPriority: vi.fn(),
  bumpWorkItemPriority: vi.fn(),
}));
vi.mock('./arm-reversible-work-item', () => ({
  planWorkItemArm: vi.fn(),
  commitWorkItemArm: vi.fn(),
}));

import { getWorkItemPriority, setWorkItemPriority, bumpWorkItemPriority } from '../../work-items';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';

const getM = vi.mocked(getWorkItemPriority);
const setM = vi.mocked(setWorkItemPriority);
const bumpM = vi.mocked(bumpWorkItemPriority);
const planArmM = vi.mocked(planWorkItemArm);
const commitArmM = vi.mocked(commitWorkItemArm);

const tool = (await import('./set_priority')).default;

type Out = { content: { text: string }[] };
const run = (args: unknown) => tool.handler(args as never, { uiClientId: 'opspawn-queen-1' } as never) as Promise<Out>;
const env = async (args: unknown) => JSON.parse((await run(args)).content[0]!.text);
const one = async (args: unknown) => (await env(args)).results[0];

beforeEach(() => {
  vi.clearAllMocks();
  planArmM.mockResolvedValue({ armed: true } as never); // a non-null plan ⇒ arming is wired
  commitArmM.mockResolvedValue(undefined as never); // returns a promise (handler does .catch on it)
});

describe('work_items:set_priority handler (bulk keyed-array)', () => {
  it('read mode (just { workItem }) reports priority, no arming, no write', async () => {
    getM.mockResolvedValue({ id: 'F-1', priority: 3, applicable: true } as never);
    const r = await one({ workItem: 'F-1' });
    expect(r).toMatchObject({ ok: true, workItem: 'F-1', mode: 'read', priority: 3, applicable: true });
    expect(planArmM).not.toHaveBeenCalled();
    expect(setM).not.toHaveBeenCalled();
    expect(bumpM).not.toHaveBeenCalled();
  });

  it('set mode ({ priority }) writes, commits the arm, mode:set/action:set', async () => {
    setM.mockResolvedValue({ id: 'F-1', priority: 5, applicable: true } as never);
    const out = await env({ workItem: 'F-1', priority: 5 });
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(out.results[0]).toMatchObject({ ok: true, workItem: 'F-1', mode: 'set', priority: 5, action: 'set' });
    expect(setM).toHaveBeenCalledWith('F-1', 5, { harness: undefined });
    expect(commitArmM).toHaveBeenCalledTimes(1);
  });

  it('clear ({ priority:null }) reports action:clear', async () => {
    setM.mockResolvedValue({ id: 'F-1', priority: null, applicable: true } as never);
    const r = await one({ workItem: 'F-1', priority: null });
    expect(r).toMatchObject({ ok: true, mode: 'set', action: 'clear' });
    expect(setM).toHaveBeenCalledWith('F-1', null, { harness: undefined });
  });

  it('bump ({ position }) calls bump, mode:bump/action:top', async () => {
    bumpM.mockResolvedValue({ id: 'F-1', priority: 0, applicable: true } as never);
    const r = await one({ workItem: 'F-1', position: 'top' });
    expect(r).toMatchObject({ ok: true, workItem: 'F-1', mode: 'bump', action: 'top', priority: 0 });
    expect(bumpM).toHaveBeenCalledWith('F-1', 'top', { harness: undefined });
    expect(commitArmM).toHaveBeenCalledTimes(1);
  });

  it('not-found fails only that item (batch survives)', async () => {
    setM.mockResolvedValue(null as never);
    const out = await env({ workItem: 'F-404', priority: 1 });
    expect(out.ok).toBe(true);
    expect(out.counts).toEqual({ ok: 0, failed: 1 });
    expect(out.results[0]).toMatchObject({ ok: false, workItem: 'F-404' });
    expect(String(out.results[0].error)).toMatch(/F-404.*not found/i);
    expect(commitArmM).not.toHaveBeenCalled();
  });

  it('a steering-lease proposal does NOT commit the arm and surfaces proposed/steeringHolder', async () => {
    setM.mockResolvedValue({ id: 'F-1', priority: 2, applicable: true, proposed: true, steeringHolder: 'queen-A' } as never);
    const r = await one({ workItem: 'F-1', priority: 2 });
    expect(r).toMatchObject({ ok: true, mode: 'set', proposed: true, steeringHolder: 'queen-A' });
    expect(commitArmM).not.toHaveBeenCalled();
  });

  it('items:[…] mixes modes, keys by workItem, honours per-item harness; one bad item fails alone', async () => {
    getM.mockResolvedValue({ id: 'F-R', priority: 9, applicable: true } as never);
    setM.mockImplementation(async (id: string) => (id === 'F-X' ? (null as never) : ({ id, priority: 1, applicable: true } as never)));
    bumpM.mockResolvedValue({ id: 'F-B', priority: 0, applicable: true } as never);
    const out = await env({
      harness: 'def',
      items: [
        { workItem: 'F-R' }, // read
        { workItem: 'F-S', priority: 1, harness: 'web' }, // set, per-item harness
        { workItem: 'F-X', priority: 2 }, // set → not found
        { workItem: 'F-B', position: 'top' }, // bump
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.counts).toEqual({ ok: 3, failed: 1 });
    expect(out.results.map((r: { workItem: string; ok: boolean; mode?: string }) => [r.workItem, r.ok, r.mode])).toEqual([
      ['F-R', true, 'read'],
      ['F-S', true, 'set'],
      ['F-X', false, undefined],
      ['F-B', true, 'bump'],
    ]);
    // per-item harness 'web' for F-S, batch default 'def' for the rest
    expect(setM).toHaveBeenCalledWith('F-S', 1, { harness: 'web' });
    expect(bumpM).toHaveBeenCalledWith('F-B', 'top', { harness: 'def' });
    expect(getM).toHaveBeenCalledWith('F-R', { harness: 'def' });
  });

  it('a thrown engine error becomes that item\'s { ok:false, workItem, error } via keyOf', async () => {
    setM.mockRejectedValue(new Error('pg down'));
    const out = await env({ workItem: 'F-1', priority: 1 });
    expect(out.results[0]).toEqual({ ok: false, workItem: 'F-1', error: 'pg down' });
  });
});
