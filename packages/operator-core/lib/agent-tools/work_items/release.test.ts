/**
 * release.test.ts — work_items:release handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fn mocked. Pins: inline single →
 * one result with workItem; ids:[…] fan-out; a not-found item fails only itself (so the
 * plan-item reflect rules fire per released item via the D-007 fan-out).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({ releaseWorkItem: vi.fn(), setWorkItemClaimHold: vi.fn() }));

import { releaseWorkItem, setWorkItemClaimHold } from '../../work-items';
const releaseM = vi.mocked(releaseWorkItem);
const holdM = vi.mocked(setWorkItemClaimHold);
const tool = (await import('./release')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  releaseM.mockImplementation(async (id: string) => ({ id, assignee: null }) as never);
  holdM.mockImplementation(async (id: string, hold: boolean) => ({ id, harness: null, hold, applicable: true }) as never);
});

describe('work_items:release handler (keyed-array)', () => {
  it('releases one inline and returns the workItem', async () => {
    const b = await body({ id: 'WI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1' } });
    expect(releaseM).toHaveBeenCalledWith('WI-1', { harness: undefined });
  });

  it('releases MANY via ids:[…]', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], harness: 'h' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(releaseM).toHaveBeenCalledWith('WI-2', { harness: 'h' });
  });

  it('a not-found item (null) fails only itself', async () => {
    releaseM.mockImplementation(async (id: string) => (id === 'WI-X' ? null : ({ id } as never)));
    const b = await body({ ids: ['WI-1', 'WI-X'] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-X' });
    expect(String(b.results[1].error)).toMatch(/WI-X.*not found/i);
  });
});

// WI-2797: claimHold — the durable self-select-exclusion lever a release can ALSO apply.
describe('work_items:release { claimHold } (WI-2797 claim-hold lever)', () => {
  it('omitting claimHold never calls setWorkItemClaimHold (no extra write when not requested)', async () => {
    const b = await body({ id: 'WI-1' });
    expect(holdM).not.toHaveBeenCalled();
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[0]).not.toHaveProperty('claimHold');
  });

  it('claimHold:true releases AND applies the hold, surfacing it in the result', async () => {
    const b = await body({ id: 'WI-1', claimHold: true });
    expect(releaseM).toHaveBeenCalledWith('WI-1', { harness: undefined });
    expect(holdM).toHaveBeenCalledWith('WI-1', true, { harness: undefined });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', claimHold: true });
  });

  it('claimHold:false clears a prior hold', async () => {
    const b = await body({ id: 'WI-1', claimHold: false });
    expect(holdM).toHaveBeenCalledWith('WI-1', false, { harness: undefined });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', claimHold: false });
  });

  it('a feature-family item (not applicable) omits claimHold from the result rather than reporting a false hold', async () => {
    holdM.mockResolvedValue({ id: 'F-1', harness: null, hold: false, applicable: false } as never);
    const b = await body({ id: 'F-1', claimHold: true });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'F-1' });
    expect(b.results[0].claimHold).toBeUndefined();
  });

  it('a batch default claimHold applies to every item unless a per-item override is given', async () => {
    const b = await body({ items: [{ id: 'WI-1' }, { id: 'WI-2', claimHold: false }], claimHold: true });
    expect(holdM).toHaveBeenNthCalledWith(1, 'WI-1', true, { harness: undefined });
    expect(holdM).toHaveBeenNthCalledWith(2, 'WI-2', false, { harness: undefined });
    expect(b.results[0]).toMatchObject({ claimHold: true });
    expect(b.results[1]).toMatchObject({ claimHold: false });
  });

  it('per-item harness flows through to setWorkItemClaimHold', async () => {
    await body({ items: [{ id: 'WI-1', harness: 'h1', claimHold: true }], harness: 'default-h' });
    expect(holdM).toHaveBeenCalledWith('WI-1', true, { harness: 'h1' });
  });
});
