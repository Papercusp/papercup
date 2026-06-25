/**
 * claim.test.ts — work_items:claim handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fns mocked. Pins: inline single
 * success → one result with workItem; ids:[…] fan-out; a claim_conflict (EI-2197
 * classify) fails only that item and carries holder/hint; top-level ok stays true.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me' }));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId }),
}));
vi.mock('../../work-items', () => ({ claimWorkItem: vi.fn(), classifyClaimFailure: vi.fn(), getWorkItem: vi.fn() }));

import { claimWorkItem, classifyClaimFailure, getWorkItem } from '../../work-items';
const claimM = vi.mocked(claimWorkItem);
const classifyM = vi.mocked(classifyClaimFailure);
const getM = vi.mocked(getWorkItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  claimM.mockImplementation(async (id: string) => ({ id, assignee: 'me' }) as never);
});

describe('work_items:claim handler (keyed-array)', () => {
  it('claims one inline for the caller and returns the workItem', async () => {
    const b = await body({ id: 'WI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1', assignee: 'me' } });
    expect(claimM).toHaveBeenCalledWith('WI-1', 'me', { harness: undefined });
  });

  it('claims MANY via ids:[…] for an explicit assignee', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], assignee: 'bee-7' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(claimM).toHaveBeenCalledWith('WI-2', 'bee-7', { harness: undefined });
  });

  it('refuses implicit claims as the shared su-loopback fallback', async () => {
    identity.ownerId = 'su-loopback';
    const b = await body({ id: 'WI-LOOPBACK' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-LOOPBACK', error: 'missing_client_identity' });
    expect(b.results[0].hint).toMatch(/real per-session or spawn owner/);
    expect(claimM).not.toHaveBeenCalled();
  });

  it('still permits explicit assignee claims from a su-loopback caller', async () => {
    identity.ownerId = 'su-loopback';
    const b = await body({ id: 'WI-DIRECTED', assignee: 's-bee-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-DIRECTED', 's-bee-1', { harness: undefined });
  });

  it('a claim_conflict fails only that item (top-level ok stays true) with holder + hint', async () => {
    claimM.mockImplementation(async (id: string) => (id === 'WI-HELD' ? null : ({ id, assignee: 'me' } as never)));
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    classifyM.mockReturnValue({ reason: 'conflict', holder: 'peer' } as never);
    const b = await body({ ids: ['WI-1', 'WI-HELD'] });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'claim_conflict', holder: 'peer' });
    expect(b.results[1].hint).toMatch(/Already claimed by peer/);
  });

  it('a not-found item is classified and reported per item', async () => {
    claimM.mockResolvedValue(null as never);
    getM.mockResolvedValue(null as never);
    classifyM.mockReturnValue({ reason: 'not_found' } as never);
    const b = await body({ id: 'WI-404' });
    expect(b.results[0]).toEqual({ ok: false, id: 'WI-404', error: "work_item 'WI-404' not found" });
  });
});
