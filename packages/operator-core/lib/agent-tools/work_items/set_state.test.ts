/**
 * set_state.test.ts — work_items:set_state handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine + P-114 arm mocked. Pins: inline
 * single → one result; ids:[…]+state homogeneous; items:[…] heterogeneous states; a
 * not-found item fails only itself; the P-114 arm is evaluated per item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../work-items', () => ({ setWorkItemStateWithAliasInfo: vi.fn() }));
vi.mock('./arm-reversible-work-item', () => ({ planWorkItemArm: vi.fn(async () => null), commitWorkItemArm: vi.fn() }));

import { setWorkItemStateWithAliasInfo } from '../../work-items';
import { planWorkItemArm } from './arm-reversible-work-item';
const setM = vi.mocked(setWorkItemStateWithAliasInfo);
const armM = vi.mocked(planWorkItemArm);
const tool = (await import('./set_state')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

/** Default mock: no alias — the item lands exactly on the requested state. */
function noAlias(id: string, state: string) {
  return { workItem: { id, state }, aliased: false, requestedState: state, appliedState: state } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  armM.mockResolvedValue(null as never);
  setM.mockImplementation(async (id: string, state: string) => noAlias(id, state));
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
      force: undefined,
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
      force: undefined,
    });
  });

  it('items:[…] sets heterogeneous states per item', async () => {
    const b = await body({ items: [{ id: 'WI-1', state: 'passed' }, { id: 'WI-2', state: 'failing' }] });
    expect(b.results[0].workItem.state).toBe('passed');
    expect(b.results[1].workItem.state).toBe('failing');
  });

  it('a not-found item (null workItem) fails only itself', async () => {
    setM.mockImplementation(async (id: string, state: string) =>
      id === 'WI-X'
        ? ({ workItem: null, aliased: false, requestedState: state, appliedState: null } as never)
        : noAlias(id, state),
    );
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
  it('surfaces an aliasNote when the write aliases', async () => {
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'open' },
      aliased: true,
      requestedState: state,
      appliedState: 'open',
      aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
    }) as never);
    const b = await body({ id: 'WI-1', state: 'blocked' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { state: 'open' } });
    expect(b.results[0].aliasNote).toMatch(/requested state 'blocked'.*recorded as 'open'/);
  });

  it('omits aliasNote entirely when the requested state is already canonical (no alias fired)', async () => {
    // Default mock: no alias — mirrors a canonical state like 'resolved'.
    const b = await body({ id: 'WI-1', state: 'resolved' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[0]).not.toHaveProperty('aliasNote');
  });

  it('each item in a heterogeneous batch gets its OWN aliasNote independently', async () => {
    setM.mockImplementation(async (id: string, state: string) =>
      state === 'wip'
        ? ({
            workItem: { id, state: 'open' },
            aliased: true,
            requestedState: state,
            appliedState: 'open',
            aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
          } as never)
        : noAlias(id, state),
    );
    const b = await body({ items: [{ id: 'WI-1', state: 'wip' }, { id: 'WI-2', state: 'resolved' }] });
    expect(b.results[0].aliasNote).toBeTruthy();
    expect(b.results[1]).not.toHaveProperty('aliasNote');
  });
});

// EI-7712: the fail-loud contract every result row now carries — `aliased` /
// `requestedState` / `appliedState` are present on EVERY successful result, not just
// when an aliasNote string is generated, so a careless caller comparing appliedState
// against what it asked for catches a divergence even without pattern-matching prose.
describe('work_items:set_state — aliased/requestedState/appliedState on every result (EI-7712)', () => {
  it('a clean (non-aliased) write reports aliased:false with matching requested/applied state', async () => {
    const b = await body({ id: 'WI-1', state: 'resolved' });
    expect(b.results[0]).toMatchObject({ aliased: false, requestedState: 'resolved', appliedState: 'resolved' });
  });

  it('an aliased write reports aliased:true with DIVERGENT requested/applied state, even without reading aliasNote', async () => {
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'open' },
      aliased: true,
      requestedState: state,
      appliedState: 'open',
      aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
    }) as never);
    const b = await body({ id: 'WI-1', state: 'blocked' });
    expect(b.results[0].aliased).toBe(true);
    expect(b.results[0].requestedState).toBe('blocked');
    expect(b.results[0].appliedState).toBe('open');
    expect(b.results[0].requestedState).not.toBe(b.results[0].appliedState);
  });

  it('a silent divergence with NO onAlias fire (a hypothetical future bug class) still surfaces as aliased:true — the WI-2381 recurrence guard', async () => {
    // Simulates a lower-layer bug that persists a DIFFERENT state than requested
    // WITHOUT the normalize-layer onAlias ever firing — setWorkItemStateWithAliasInfo's
    // own appliedState-vs-requestedState comparison (not just onAlias) must still catch it.
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'open' }, // silently stayed 'open' instead of 'blocked'
      aliased: true,
      requestedState: state,
      appliedState: 'open',
      aliasNote: `requested state '${state}' was not applied verbatim — recorded as 'open' instead.`,
    }) as never);
    const b = await body({ id: 'WI-2381', state: 'blocked' });
    expect(b.results[0].ok).toBe(true); // the write itself succeeded — this is exactly why `ok` alone is not enough
    expect(b.results[0].aliased).toBe(true); // but the discriminator catches the divergence
    expect(b.results[0].appliedState).not.toBe(b.results[0].requestedState);
  });
});
