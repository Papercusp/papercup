/**
 * release.test.ts — work_items:release handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fn mocked. Pins: inline single →
 * one result with workItem; ids:[…] fan-out; a not-found item fails only itself (so the
 * plan-item reflect rules fire per released item via the D-007 fan-out).
 *
 * EI-7588: release now compare-and-releases under the caller's resolved identity
 * (`expectedAssignee`) unless `force` — a peer's live claim comes back `not_holder`
 * + `holder` instead of being silently cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me' }));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId }),
}));
vi.mock('../../work-items', () => ({ releaseWorkItem: vi.fn(), setWorkItemClaimHold: vi.fn(), getWorkItem: vi.fn() }));

import { releaseWorkItem, setWorkItemClaimHold, getWorkItem } from '../../work-items';
const releaseM = vi.mocked(releaseWorkItem);
const holdM = vi.mocked(setWorkItemClaimHold);
const getM = vi.mocked(getWorkItem);
const tool = (await import('./release')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  releaseM.mockImplementation(async (id: string) => ({ id, assignee: null }) as never);
  holdM.mockImplementation(async (id: string, hold: boolean) => ({ id, harness: null, hold, applicable: true }) as never);
});

describe('work_items:release handler (keyed-array)', () => {
  it('releases one inline and returns the workItem', async () => {
    const b = await body({ id: 'WI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1' } });
    expect(releaseM).toHaveBeenCalledWith('WI-1', { harness: undefined, expectedAssignee: 'me' });
  });

  it('releases MANY via ids:[…]', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], harness: 'h' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(releaseM).toHaveBeenCalledWith('WI-2', { harness: 'h', expectedAssignee: 'me' });
  });

  it('a not-found item (null) fails only itself', async () => {
    releaseM.mockImplementation(async (id: string) => (id === 'WI-X' ? null : ({ id } as never)));
    getM.mockResolvedValue(null as never);
    const b = await body({ ids: ['WI-1', 'WI-X'] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-X' });
    expect(String(b.results[1].error)).toMatch(/WI-X.*not found/i);
  });
});

// EI-7588: release refuses to silently clear ANOTHER agent's live claim.
describe('work_items:release holder guard (EI-7588)', () => {
  it('a peer-held item fails loudly with not_holder + holder, never silently clearing it', async () => {
    releaseM.mockResolvedValue(null as never); // the atomic compare-and-release matched 0 rows
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    const b = await body({ id: 'WI-HELD' });
    expect(releaseM).toHaveBeenCalledWith('WI-HELD', { harness: undefined, expectedAssignee: 'me' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'not_holder', holder: 'peer' });
    expect(b.results[0].hint).toMatch(/Held by peer, not you \(me\)/);
  });

  it('force:true releases a peer-held item anyway (leader/reaper override)', async () => {
    const b = await body({ id: 'WI-HELD', force: true });
    expect(releaseM).toHaveBeenCalledWith('WI-HELD', { harness: undefined, expectedAssignee: undefined });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-HELD' });
    expect(getM).not.toHaveBeenCalled();
  });

  it('a batch default force applies to every item unless a per-item override is given', async () => {
    releaseM.mockImplementation(async (id: string, opts?: { expectedAssignee?: string }) =>
      opts?.expectedAssignee && id === 'WI-2' ? null : ({ id } as never),
    );
    getM.mockResolvedValue({ id: 'WI-2', assignee: 'peer' } as never);
    const b = await body({ items: [{ id: 'WI-1' }, { id: 'WI-2', force: false }], force: true });
    expect(releaseM).toHaveBeenNthCalledWith(1, 'WI-1', { harness: undefined, expectedAssignee: undefined });
    expect(releaseM).toHaveBeenNthCalledWith(2, 'WI-2', { harness: undefined, expectedAssignee: 'me' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-2', error: 'not_holder', holder: 'peer' });
  });

  it('releasing an already-unclaimed item still succeeds (no holder to conflict with)', async () => {
    const b = await body({ id: 'WI-FREE' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-FREE' });
    expect(getM).not.toHaveBeenCalled();
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

  it('claimHold:true releases AND applies the hold (stamping the caller as holder), surfacing it in the result', async () => {
    const b = await body({ id: 'WI-1', claimHold: true });
    expect(releaseM).toHaveBeenCalledWith('WI-1', { harness: undefined, expectedAssignee: 'me' });
    // P-006: the hold is stamped with WHO applied it (held_open_by), so peers see whose gate it is.
    expect(holdM).toHaveBeenCalledWith('WI-1', true, { harness: undefined, by: 'me' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', claimHold: true });
  });

  it('claimHold:false clears a prior hold', async () => {
    const b = await body({ id: 'WI-1', claimHold: false });
    expect(holdM).toHaveBeenCalledWith('WI-1', false, { harness: undefined, by: 'me' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', claimHold: false });
  });

  it('a hold-engine miss (null — item vanished between release and hold) omits claimHold rather than reporting a false hold', async () => {
    holdM.mockResolvedValue(null as never);
    const b = await body({ id: 'F-1', claimHold: true });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'F-1' });
    expect(b.results[0].claimHold).toBeUndefined();
  });

  it('a batch default claimHold applies to every item unless a per-item override is given', async () => {
    const b = await body({ items: [{ id: 'WI-1' }, { id: 'WI-2', claimHold: false }], claimHold: true });
    expect(holdM).toHaveBeenNthCalledWith(1, 'WI-1', true, { harness: undefined, by: 'me' });
    expect(holdM).toHaveBeenNthCalledWith(2, 'WI-2', false, { harness: undefined, by: 'me' });
    expect(b.results[0]).toMatchObject({ claimHold: true });
    expect(b.results[1]).toMatchObject({ claimHold: false });
  });

  it('per-item harness flows through to setWorkItemClaimHold', async () => {
    await body({ items: [{ id: 'WI-1', harness: 'h1', claimHold: true }], harness: 'default-h' });
    expect(holdM).toHaveBeenCalledWith('WI-1', true, { harness: 'h1', by: 'me' });
  });
});
