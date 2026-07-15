/**
 * ref-alias.test.ts — EI-11400. A rubric is identified by its ref/slug, and the
 * rubric tool family must accept that noun under ONE canonical vocabulary PLUS the
 * obvious alias, so the first call lands instead of costing a schema-probe retry.
 *
 * Guards:
 *   - rubrics:get + rubrics:trend both accept the canonical `rubricRef` (parity), and
 *   - both accept `rubricId`(`s`) as an ACCEPTED ALIAS that resolves to `rubricRef`(`s`)
 *     (the id an agent reaches for after rubrics:list, and the vocabulary rubrics:get
 *     itself required before it was bulk-standardized), and
 *   - a genuine both-with-different-values conflict is rejected LOUDLY (never silently
 *     picking a winner) — the same contract as the body↔summary alias (WI-4492).
 *
 * Mirrors the accepted-alias precedent (EI-10897 comment↔body, _body-alias.ts).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/rubrics/ref-alias.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../rubrics', () => ({ getRubric: vi.fn() }));
vi.mock('../../scorecards', () => ({ scorecardTrend: vi.fn() }));

import { getRubric } from '../../rubrics';
import { scorecardTrend } from '../../scorecards';
const getM = vi.mocked(getRubric);
const trendM = vi.mocked(scorecardTrend);

const getTool = (await import('./get')).default;
const trendTool = (await import('./trend')).default;

type Out = { data: any };
const getData = async (args: unknown) => (((await getTool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => vi.clearAllMocks());

describe('rubrics:get — rubricId/rubricIds alias resolves to rubricRef/rubricRefs (EI-11400)', () => {
  it('resolves a single `rubricId` to a canonical ref', async () => {
    getM.mockResolvedValue({ id: 'r-1', criteria: [] } as never);
    const b = await getData({ rubricId: 'r-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, rubricId: 'r-1' });
    expect(getM).toHaveBeenCalledWith('r-1');
  });

  it('resolves `rubricIds` (bulk) to canonical refs', async () => {
    getM.mockImplementation(async (id: string) => ({ id }) as never);
    const b = await getData({ rubricIds: ['a', 'b'] });
    expect(b.results.map((r: { rubricId: string }) => r.rubricId)).toEqual(['a', 'b']);
  });

  it('the canonical `rubricRef` still works unchanged', async () => {
    getM.mockResolvedValue({ id: 'r-9', criteria: [] } as never);
    const b = await getData({ rubricRef: 'r-9' });
    expect(b.results[0]).toMatchObject({ ok: true, rubricId: 'r-9' });
  });
});

describe('rubrics:trend — rubricId alias resolves to rubricRef (EI-11400)', () => {
  it('passes a `rubricId` through as the canonical rubricRef', async () => {
    trendM.mockResolvedValue({} as never);
    await trendTool.handler({ rubricId: 'queen-placement-health' } as never, {} as never);
    expect(trendM).toHaveBeenCalledWith(expect.objectContaining({ rubricRef: 'queen-placement-health' }));
  });

  it('the canonical `rubricRef` still works unchanged', async () => {
    trendM.mockResolvedValue({} as never);
    await trendTool.handler({ rubricRef: 'q-health' } as never, {} as never);
    expect(trendM).toHaveBeenCalledWith(expect.objectContaining({ rubricRef: 'q-health' }));
  });
});

describe('rubric-ref vocabulary parity (EI-11400)', () => {
  it('both rubrics:get and rubrics:trend accept the canonical `rubricRef`', () => {
    expect(getTool.args.safeParse({ rubricRef: 'r' }).success).toBe(true);
    expect(trendTool.args.safeParse({ rubricRef: 'r' }).success).toBe(true);
  });

  it('both accept the `rubricId` alias', () => {
    expect(getTool.args.safeParse({ rubricId: 'r' }).success).toBe(true);
    expect(trendTool.args.safeParse({ rubricId: 'r' }).success).toBe(true);
  });

  it('both reject an empty call (no ref, no alias)', () => {
    expect(getTool.args.safeParse({}).success).toBe(false);
    expect(trendTool.args.safeParse({}).success).toBe(false);
  });

  it('rubrics:get rejects `rubricRef` + `rubricId` passed with DIFFERENT values', () => {
    expect(getTool.args.safeParse({ rubricRef: 'a', rubricId: 'b' }).success).toBe(false);
  });

  it('rubrics:trend rejects `rubricRef` + `rubricId` passed with DIFFERENT values', () => {
    expect(trendTool.args.safeParse({ rubricRef: 'a', rubricId: 'b' }).success).toBe(false);
  });
});
