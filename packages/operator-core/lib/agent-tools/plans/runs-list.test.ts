/**
 * runs-list.test.ts — the plans:runs HANDLER (listPlanRuns/sweepPlanRuns mocked). Pins
 * the handler's own discipline: it runs the best-effort lifecycle sweep first, returns
 * the runs (empty list is NOT an error), emits a runCount breadcrumb, and — the
 * load-bearing bit — maps a genuine DB failure to an explicit isError
 * {error:'runs_unavailable'} rather than a misleading empty list. console is suppressed
 * (operator-core is fail-on-console; the sweep warns on its own failure path).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/runs-list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: vi.fn(() => 'web') }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('./runs', () => ({ listPlanRuns: vi.fn(), sweepPlanRuns: vi.fn() }));

import { listPlanRuns, sweepPlanRuns } from './runs';
import type { PlanRunSummary, SweepPlanRunsResult } from './runs';
import { mockRejectedTyped, mockResolvedTyped } from '../../testing/typed-mock';
const listM = vi.mocked(listPlanRuns);
const sweepM = vi.mocked(sweepPlanRuns);
const tool = (await import('./runs-list')).default;

/** A COMPLETE PlanRunSummary with a Partial override seam — so these fixtures are
 *  genuinely typechecked against the real signature instead of cast past it with
 *  `as never`. A field added to PlanRunSummary now fails HERE, at author time,
 *  rather than silently rotting until someone else's green-checkpoint. */
const planRun = (overrides: Partial<PlanRunSummary> = {}): PlanRunSummary => ({
  id: 1,
  planSlug: 'p1',
  planContentHash: 'hash',
  sessionId: 'sess-1',
  note: null,
  launchedBy: 'tester',
  launchedAt: 0,
  status: 'done',
  title: 'r1',
  updatedAt: 0,
  runType: 'interactive',
  trigger: null,
  outcome: null,
  finishedAt: null,
  runSeq: null,
  instancePlanSlug: null,
  durationMs: null,
  turnCount: null,
  workItems: { total: 0, passed: 0, failed: 0, open: 0 },
  costUsd: 0,
  resultSummary: null,
  ...overrides,
});

type Out = { content: { text: string }[]; isError?: boolean };
const meta = vi.fn();
const call = (slug = 'p1') => tool.handler({ slug, harness: 'web' } as never, { metadata: meta } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockResolvedTyped(sweepM, { failed: 0, archived: 0 });
});

describe('plans:runs handler', () => {
  it('sweeps, returns the runs, and emits a runCount breadcrumb', async () => {
    mockResolvedTyped(listM, [planRun({ id: 1, title: 'r1', status: 'done' })]);
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ runs: [{ id: 1, title: 'r1' }] });
    expect(sweepM).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledWith({ slug: 'p1', runCount: 1, sweepRan: true });
  });

  it('returns an empty list (not an error) when the plan has no runs', async () => {
    mockResolvedTyped(listM, []);
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ runs: [] });
  });

  it('maps a DB failure to runs_unavailable (isError) — never a misleading empty list', async () => {
    mockRejectedTyped(listM, new Error('pg down'));
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'runs_unavailable', slug: 'p1' });
    expect(String(body(out).message)).toMatch(/pg down/);
  });

  // P-006/D-004: the sweep's outcome is REPORTED, not discarded. Before this, the
  // result was thrown away behind `.catch(console.warn)`, so a read whose sweep
  // never ran was byte-identical to one whose sweep ran clean — and this read is
  // the only way to observe the orphan it repairs.
  describe('sweep effect reporting', () => {
    it('reports what the sweep actually reclaimed, and says so in the note', async () => {
      mockResolvedTyped(listM, []);
      mockResolvedTyped(sweepM, { failed: 2, archived: 3 });
      const { sweep } = body(await call());
      expect(sweep).toMatchObject({ ran: true, failed: 2, archived: 3 });
      expect(String(sweep.note)).toMatch(/reclaimed 2 orphaned.*archived 3 stale/s);
    });

    it('a clean no-op sweep reports ran:true with zero counts and no alarming note', async () => {
      mockResolvedTyped(listM, []);
      const { sweep } = body(await call());
      expect(sweep).toMatchObject({ ran: true, failed: 0, archived: 0 });
      expect(sweep.note).toBeUndefined();
      expect(sweep.error).toBeUndefined();
    });

    // The load-bearing case: a failed sweep must NOT read as a successful one,
    // and must NOT break the list read.
    it('a FAILED sweep reports ran:false with the reason, and still returns the runs', async () => {
      mockResolvedTyped(listM, [planRun({ id: 7, title: 'r7', status: 'running' })]);
      mockRejectedTyped(sweepM, new Error('sweep pg timeout'));
      const out = await call();
      expect(out.isError).toBeUndefined();
      const { runs, sweep } = body(out);
      expect(runs).toMatchObject([{ id: 7 }]);
      expect(sweep.ran).toBe(false);
      expect(String(sweep.error)).toMatch(/sweep pg timeout/);
      expect(String(sweep.note)).toMatch(/not evidence of a live run|NOT\b.*reclaimed/is);
      expect(meta).toHaveBeenCalledWith({ slug: 'p1', runCount: 1, sweepRan: false });
    });

    // A malformed result must not be coerced into `failed:0, archived:0` — that is
    // a real reading ("nothing needed reclaiming"), so forging it would fabricate
    // exactly the confident answer this item exists to stop manufacturing.
    it('a malformed sweep result reports ran:false rather than a forged clean zero', async () => {
      mockResolvedTyped(listM, []);
      // Deliberate contract violation — simulating a RUNTIME shape break that the
      // type system cannot prevent (a stale deploy, a changed store). The cast is
      // the subject of the test, not an escape from checking it.
      mockResolvedTyped(sweepM, undefined as unknown as SweepPlanRunsResult);
      const { sweep } = body(await call());
      expect(sweep.ran).toBe(false);
      expect(sweep.failed).toBeUndefined();
      expect(sweep.archived).toBeUndefined();
      expect(String(sweep.error)).toMatch(/unexpected shape/);
    });
  });
});
