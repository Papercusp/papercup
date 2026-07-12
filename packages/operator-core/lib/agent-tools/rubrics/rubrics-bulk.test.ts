/**
 * rubrics-bulk.test.ts — rubrics:get (read) + rubrics:ratify (action) HANDLERS,
 * bulk keyed-array contract (bulk-endpoint-standardization-2026-06-21). The
 * rubrics engine + identity are mocked. Pins the inline single form, the
 * rubricIds:[…] many form (per-item results keyed by rubricId), and a not-found
 * item failing only itself while the batch's top-level ok stays true.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/rubrics/rubrics-bulk.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
// rubricCompleteness is mocked shape-only here (WI-4287: ratify surfaces it per result);
// its real logic is pinned in lib/rubrics-loss-guards.test.ts.
vi.mock('../../rubrics', () => ({
  getRubric: vi.fn(),
  ratifyRubric: vi.fn(),
  rubricCompleteness: vi.fn(() => ({ criteriaWithoutReplication: [], methodRefMissing: false, complete: true })),
}));

import { getRubric, ratifyRubric } from '../../rubrics';
const getM = vi.mocked(getRubric);
const ratifyM = vi.mocked(ratifyRubric);

const getTool = (await import('./get')).default;
const ratifyTool = (await import('./ratify')).default;

type Out = { data: any };
const body = async (tool: typeof getTool, args: unknown) =>
  (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => vi.clearAllMocks());

describe('rubrics:get handler (bulk keyed-array)', () => {
  it('inline { rubricId } returns a single result', async () => {
    getM.mockResolvedValue({ id: 'r-1', criteria: [] } as never);
    const b = await body(getTool, { rubricId: 'r-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, rubricId: 'r-1', rubric: { id: 'r-1' } });
  });

  it('rubricIds:[…] fetches many; a not-found item fails only itself', async () => {
    getM.mockImplementation(async (id: string) => (id === 'gone' ? null : ({ id } as never)));
    const b = await body(getTool, { rubricIds: ['r-1', 'gone', 'r-2'] });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: { rubricId: string; ok: boolean }) => [r.rubricId, r.ok])).toEqual([
      ['r-1', true],
      ['gone', false],
      ['r-2', true],
    ]);
    expect(b.results[1]).toMatchObject({ ok: false, rubricId: 'gone', error: 'rubric not found' });
  });

  it('dedups rubricId + rubricIds into one merged list', async () => {
    getM.mockImplementation(async (id: string) => ({ id } as never));
    const b = await body(getTool, { rubricId: 'r-1', rubricIds: ['r-1', 'r-2'] });
    expect(b.results.map((r: { rubricId: string }) => r.rubricId)).toEqual(['r-1', 'r-2']);
  });
});

describe('rubrics:ratify handler (bulk keyed-array)', () => {
  it('ratifies one inline and returns the activated rubric', async () => {
    ratifyM.mockResolvedValue({ id: 'r-1', status: 'active' } as never);
    const b = await body(ratifyTool, { rubricId: 'r-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, rubricId: 'r-1', rubric: { status: 'active' } });
    // WI-4287: each activated rubric reports its testing-procedure completeness.
    expect(b.results[0].completeness).toEqual({
      criteriaWithoutReplication: [],
      methodRefMissing: false,
      complete: true,
    });
    expect(ratifyM).toHaveBeenCalledWith('r-1', 'me');
  });

  it('ratifies MANY via rubricIds:[…]; a missing one fails only itself', async () => {
    ratifyM.mockImplementation(async (id: string) => (id === 'gone' ? null : ({ id, status: 'active' } as never)));
    const b = await body(ratifyTool, { rubricIds: ['r-1', 'gone'] });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, rubricId: 'r-1' });
    expect(b.results[1]).toMatchObject({ ok: false, rubricId: 'gone', error: 'rubric not found' });
  });
});
