/**
 * set_state.test.ts — work_items:set_state handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine + P-114 arm mocked. Pins: inline
 * single → one result; ids:[…]+state homogeneous; items:[…] heterogeneous states; a
 * not-found item fails only itself; the P-114 arm is evaluated per item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../work-items', () => ({ setWorkItemState: vi.fn() }));
vi.mock('./arm-reversible-work-item', () => ({ planWorkItemArm: vi.fn(async () => null), commitWorkItemArm: vi.fn() }));

import { setWorkItemState } from '../../work-items';
import { planWorkItemArm } from './arm-reversible-work-item';
const setM = vi.mocked(setWorkItemState);
const armM = vi.mocked(planWorkItemArm);
const tool = (await import('./set_state')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  armM.mockResolvedValue(null as never);
  setM.mockImplementation(async (id: string, state: string) => ({ id, state }) as never);
});

describe('work_items:set_state handler (keyed-array)', () => {
  it('sets one inline and returns the workItem', async () => {
    const b = await body({ id: 'WI-1', state: 'passed' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1', state: 'passed' } });
    expect(setM).toHaveBeenCalledWith('WI-1', 'passed', {
      harness: undefined,
      by: 'me',
      completionRef: undefined,
      onAlias: expect.any(Function),
    });
  });

  it('sets MANY to the same state via ids:[…] (homogeneous) — arm evaluated per item', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], state: 'resolved', harness: 'h' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.every((r: { workItem: { state: string } }) => r.workItem.state === 'resolved')).toBe(true);
    expect(armM).toHaveBeenCalledTimes(2);
    expect(setM).toHaveBeenCalledWith('WI-2', 'resolved', {
      harness: 'h',
      by: 'me',
      completionRef: undefined,
      onAlias: expect.any(Function),
    });
  });

  it('items:[…] sets heterogeneous states per item', async () => {
    const b = await body({ items: [{ id: 'WI-1', state: 'passed' }, { id: 'WI-2', state: 'failing' }] });
    expect(b.results[0].workItem.state).toBe('passed');
    expect(b.results[1].workItem.state).toBe('failing');
  });

  it('a not-found item (null) fails only itself', async () => {
    setM.mockImplementation(async (id: string, state: string) => (id === 'WI-X' ? null : ({ id, state } as never)));
    const b = await body({ ids: ['WI-1', 'WI-X'], state: 'done' });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-X' });
  });

  it('a thrown engine error (unmappable state) becomes that item\'s {ok:false}', async () => {
    setM.mockRejectedValueOnce(new Error('cannot take state'));
    const b = await body({ id: 'WI-1', state: 'bogus' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-1' });
    expect(String(b.results[0].error)).toMatch(/cannot take state/);
  });
});

// EI-7125 / WI-2573: an issue-family 'blocked'/'needs-human'/etc request silently
// aliases to 'open' inside setWorkItemState (EI-450) — this used to read as an
// unexplained ok:true no-op. onAlias now lets the tool surface a per-item note.
describe('work_items:set_state — alias note (EI-7125 / WI-2573)', () => {
  it('surfaces an aliasNote when setWorkItemState fires onAlias', async () => {
    setM.mockImplementation(async (id: string, state: string, opts?: { onAlias?: (i: { requested: string; resolved: string }) => void }) => {
      opts?.onAlias?.({ requested: state, resolved: 'open' });
      return { id, state: 'open' } as never;
    });
    const b = await body({ id: 'WI-1', state: 'blocked' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { state: 'open' } });
    expect(b.results[0].aliasNote).toMatch(/requested state 'blocked'.*recorded as 'open'/);
  });

  it('omits aliasNote entirely when the requested state is already canonical (no alias fired)', async () => {
    // Default mock never calls onAlias — mirrors a canonical state like 'resolved'.
    const b = await body({ id: 'WI-1', state: 'resolved' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[0]).not.toHaveProperty('aliasNote');
  });

  it('each item in a heterogeneous batch gets its OWN aliasNote independently', async () => {
    setM.mockImplementation(async (id: string, state: string, opts?: { onAlias?: (i: { requested: string; resolved: string }) => void }) => {
      if (state === 'wip') opts?.onAlias?.({ requested: state, resolved: 'open' });
      return { id, state: state === 'wip' ? 'open' : state } as never;
    });
    const b = await body({ items: [{ id: 'WI-1', state: 'wip' }, { id: 'WI-2', state: 'resolved' }] });
    expect(b.results[0].aliasNote).toBeTruthy();
    expect(b.results[1]).not.toHaveProperty('aliasNote');
  });
});
