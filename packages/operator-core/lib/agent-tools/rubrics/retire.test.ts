/**
 * retire.test.ts — rubrics:retire HANDLER (EI-20276435149948191), the missing inverse
 * of rubrics:ratify. The rubrics engine + identity are mocked; the engine's own
 * acceptance-kind refusal and idempotence live in retireRubric.
 *
 * Pins four things the verb promises and one it must NOT do:
 *  - the inline single form and the rubricRefs:[…] many form, keyed by `rubricRef`;
 *  - `reason` reaching the engine (it lands on the audit revision, so a dropped
 *    reason silently costs the only record of WHY a shared standard was retired);
 *  - a not-found ref failing ONLY itself;
 *  - an engine THROW (the acceptance-kind governance refusal) isolating to its own
 *    entry — the property the doc comment on retire.ts claims. runBulk's catch-all is
 *    what delivers it, so this is a real regression risk if the handler ever grows its
 *    own try/catch or stops going through runBulk.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/rubrics/retire.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../rubrics', () => ({ retireRubric: vi.fn() }));
// The handler fires a detached sync-invalidate; keep it inert so a rejected dynamic
// import can never surface as a test failure unrelated to the contract under test.
vi.mock('../../detached-imports', () => ({ trackDetached: () => Promise.resolve({ notifySyncInvalidate: () => {} }) }));

import { retireRubric } from '../../rubrics';
import type { Rubric } from '../../rubrics';
const retireM = vi.mocked(retireRubric);

/** A COMPLETE, typed retired `Rubric` — the typed-mock alternative to `{ … } as never`. */
const RETIRED_R1: Rubric = {
  rubricId: 'r-1',
  workspaceId: 'default',
  kind: 'standard',
  gradingAuthority: 'independent',
  characteristic: 'cup-lifecycle',
  title: 'r-1',
  description: '',
  criteria: [],
  ratingScale: [],
  methodRef: null,
  status: 'retired',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const retireTool = (await import('./retire')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await retireTool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => vi.clearAllMocks());

describe('rubrics:retire handler (bulk keyed-array)', () => {
  it('retires a single rubric inline and passes the actor through', async () => {
    retireM.mockResolvedValue(RETIRED_R1);
    const b = await body({ rubricRef: 'r-1' });
    expect(b.ok).toBe(true);
    expect(b.counts).toMatchObject({ ok: 1, failed: 0 });
    expect(b.results[0]).toMatchObject({ ok: true, rubricRef: 'r-1' });
    expect(b.results[0].rubric.status).toBe('retired');
    expect(retireM).toHaveBeenCalledWith('r-1', 'me', undefined);
  });

  it('threads `reason` to the engine so it lands on the audit revision', async () => {
    retireM.mockResolvedValue(RETIRED_R1);
    await body({ rubricRef: 'r-1', reason: 'Mug/Cup/Kettle tier deleted 2026-08-09' });
    expect(retireM).toHaveBeenCalledWith('r-1', 'me', 'Mug/Cup/Kettle tier deleted 2026-08-09');
  });

  it('retires many, keyed by rubricRef, with a not-found failing only itself', async () => {
    retireM.mockImplementation(async (id: string) => (id === 'gone' ? null : { ...RETIRED_R1, rubricId: id }));
    const b = await body({ rubricRefs: ['r-1', 'gone', 'r-2'] });
    // The batch as a whole still succeeded — one bad ref is not a batch failure.
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toMatchObject({ ok: 2, failed: 1 });
    const byRef = Object.fromEntries(b.results.map((r: { rubricRef: string }) => [r.rubricRef, r]));
    expect(byRef['r-1'].ok).toBe(true);
    expect(byRef['r-2'].ok).toBe(true);
    expect(byRef['gone']).toMatchObject({ ok: false, error: 'rubric not found' });
  });

  it('isolates the acceptance-kind governance REFUSAL to its own entry (a throw, not a null)', async () => {
    // retireRubric THROWS for an acceptance rubric rather than returning null, because
    // "you may not do this" and "it does not exist" are different answers. The batch
    // must survive it — otherwise one mis-typed ref silently drops the retirements the
    // caller actually asked for.
    retireM.mockImplementation(async (id: string) => {
      if (id === 'acc-1') throw new Error('invalid_args: retireRubric: acceptance rubrics are never retired by hand');
      return { ...RETIRED_R1, rubricId: id };
    });
    const b = await body({ rubricRefs: ['r-1', 'acc-1', 'r-2'] });
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toMatchObject({ ok: 2, failed: 1 });
    const byRef = Object.fromEntries(b.results.map((r: { rubricRef: string }) => [r.rubricRef, r]));
    expect(byRef['acc-1'].ok).toBe(false);
    expect(String(byRef['acc-1'].error)).toMatch(/acceptance/i);
    // The siblings actually retired — the refusal did not abort the batch.
    expect(byRef['r-1'].ok).toBe(true);
    expect(byRef['r-2'].ok).toBe(true);
  });

  it('reports an already-retired rubric as ok (idempotent), not as an error', async () => {
    retireM.mockResolvedValue(RETIRED_R1);
    const b = await body({ rubricRef: 'r-1' });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].rubric.status).toBe('retired');
  });

  it('refuses a call naming neither rubricRef nor rubricRefs', () => {
    // The schema refine is the guard; an empty call must not silently retire nothing
    // and report success.
    const parsed = retireTool.args.safeParse({});
    expect(parsed.success).toBe(false);
  });
});
