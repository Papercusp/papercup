/**
 * claim.test.ts — the issues:claim HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fns mocked. Pins: inline single
 * success → one result with issue; ids:[…] fan-out; a claim_conflict (EI-2197
 * classify) fails only that item and carries holder/hint; top-level ok stays true.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/issues/claim.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../issues-engineer', () => ({ claimIssue: vi.fn(), getIssue: vi.fn() }));
vi.mock('../../work-items', () => ({ classifyClaimFailure: vi.fn() }));

import { claimIssue, getIssue } from '../../issues-engineer';
import { classifyClaimFailure } from '../../work-items';
const claimM = vi.mocked(claimIssue);
const getM = vi.mocked(getIssue);
const classifyM = vi.mocked(classifyClaimFailure);
const tool = (await import('./claim')).default;

type Out = { content: { text: string }[] };
const body = async (args: unknown) => JSON.parse(((await tool.handler(args as never, {} as never)) as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  claimM.mockImplementation(async (id: string) => ({ id, assignee: 'me', state: 'open' }) as never);
});

describe('issues:claim handler (bulk keyed-array)', () => {
  it('claims one inline for the caller and returns the issue', async () => {
    const b = await body({ id: 'EI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1', issue: { id: 'EI-1', assignee: 'me', state: 'open' } });
    expect(claimM).toHaveBeenCalledWith('EI-1', 'me');
  });

  it('claims MANY via ids:[…] for an explicit assignee', async () => {
    const b = await body({ ids: ['EI-1', 'EI-2'], assignee: 'bee-7' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(claimM).toHaveBeenCalledWith('EI-2', 'bee-7');
  });

  it('one ok + one claim_conflict: only the held item fails, top-level ok stays true', async () => {
    claimM.mockImplementation(async (id: string) => (id === 'EI-HELD' ? null : ({ id, assignee: 'me', state: 'open' } as never)));
    getM.mockResolvedValue({ id: 'EI-HELD', assignee: 'peer' } as never);
    classifyM.mockReturnValue({ reason: 'conflict', holder: 'peer' } as never);
    const b = await body({ ids: ['EI-1', 'EI-HELD'] });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1' });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'EI-HELD', error: 'claim_conflict', holder: 'peer' });
    expect(b.results[1].hint).toMatch(/Already claimed by peer/);
  });

  it('a not-found item is classified and reported per item', async () => {
    claimM.mockResolvedValue(null as never);
    getM.mockResolvedValue(null as never);
    classifyM.mockReturnValue({ reason: 'not_found' } as never);
    const b = await body({ id: 'EI-404' });
    expect(b.results[0]).toEqual({ ok: false, id: 'EI-404', error: "issue 'EI-404' not found" });
  });
});
