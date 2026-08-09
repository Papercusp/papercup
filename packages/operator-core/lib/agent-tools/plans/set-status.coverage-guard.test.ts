/**
 * set-status.coverage-guard.test.ts — the onlyIfNoOtherOpenCoverage guard
 * (EI-19972048649686949: "dropping a DUPLICATE work-item cascades `dropped`
 * onto its plan item, de-queueing live work that another work-item still
 * covers"). Opt-in and DESTRUCTIVE-flip-blocking (unlike the residual-coverage
 * warning): a →dropped flip carrying `onlyIfNoOtherOpenCoverage:true` is
 * SKIPPED entirely (never reaches the plan lock) when another non-terminal
 * work-item is still linked to the plan item via ANY of the three linkage
 * truth sources (`implements` edge, `relates` edge, `payload.plan_item`
 * stamp) — plan-items/reflect-rules.ts renders the flag on every automated
 * →dropped cascade so a duplicate's drop never de-queues a sibling
 * implementer's coverage.
 *
 * Sibling to set-status.residual-warning.test.ts (same lock-mocking harness);
 * this file mocks ../../plan-items/reconcile-linked-work-items instead of
 * ../../plan-items/convert, since the coverage guard reads the WIDER
 * findAllLinkedWorkItems union (implements + relates + stamp), not the
 * relates-only findCoverageWorkItems the residual warning uses.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/set-status.coverage-guard.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileMocks = vi.hoisted(() => ({
  findAllLinkedWorkItems: vi.fn(async () => [] as Array<{ id: string; state: string }>),
}));

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
// No attributable agent identity → the claim/terminal-claim discipline is skipped
// (mirrors set-status.bulk.test.ts); only the terminal-grip clear-assignment leg runs.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => {
    throw new Error('no identity in this test');
  },
}));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: (s: string) => s,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'papercup' })),
}));
vi.mock('../../plan-items/assignments', () => ({ unassignItem: vi.fn(async () => null) }));
vi.mock('../../plan-items/reconcile-linked-work-items', async (orig) => ({
  ...(await orig<typeof import('../../plan-items/reconcile-linked-work-items')>()),
  findAllLinkedWorkItems: reconcileMocks.findAllLinkedWorkItems,
}));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const tool = (await import('./set-status')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) => (((await tool.handler(args as never, {} as never)) as Out).data);

/** Drive the lock: run the mutator against a fake body carrying `currentStatus`,
 *  then return its ok-value as a successful lock outcome (mirrors bulk test). */
function lockReturnsMutatorValue(knownItems: Set<string>, currentStatus = 'wip') {
  lockM.mockImplementation(async (_ctx: unknown, opts: unknown, mutate: unknown) => {
    const intent = (opts as { intent: string }).intent;
    const itemId = /P-\d{3,}/.exec(intent)?.[0] ?? '';
    const fakeBody = knownItems.has(itemId) ? `- **${itemId}** \`${currentStatus}\` x` : '';
    const { value } = await (mutate as (b: string | null) => Promise<{ value: unknown }>)(fakeBody);
    return { kind: 'ok', value, filePath: 'plan.md' } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([]);
});

describe('plans:set-status coverage guard (EI-19972048649686949)', () => {
  it('SKIPS a → dropped flip when another non-terminal work-item still covers the plan item', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-37457', state: 'open' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-012']));
    const b = await body({
      slug: 'context-injection-retrieval-reach-and-visibility-2026-08-03',
      item: 'P-012',
      status: 'dropped',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].ok).toBe(true); // never a hard error
    expect(b.results[0].skipped).toBe('coverage_guard');
    expect(b.results[0].coveredBy).toEqual(['WI-37457']);
    expect(b.results[0].reason).toMatch(/WI-37457/);
    // Never even entered the plan lock — a true no-op, not a write-then-revert.
    expect(lockM).not.toHaveBeenCalled();
  });

  it('proceeds with the drop when nothing else covers the plan item (the flipping item excludes itself)', async () => {
    // findAllLinkedWorkItems is queried AFTER the triggering item's own state
    // already committed terminal — so the only linked row is itself, terminal.
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-37458', state: 'dropped' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-012']));
    const b = await body({
      slug: 'demo-plan',
      item: 'P-012',
      status: 'dropped',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('dropped');
  });

  it('is a no-op unless the caller opts in with onlyIfNoOtherOpenCoverage — a bare → dropped flip is unaffected even with open coverage', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-37457', state: 'open' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-012']));
    const b = await body({ slug: 'demo-plan', item: 'P-012', status: 'dropped' });
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('dropped');
    expect(reconcileMocks.findAllLinkedWorkItems).not.toHaveBeenCalled();
  });

  it('never checks coverage on a status other than dropped, even with the flag set', async () => {
    lockReturnsMutatorValue(new Set(['P-012']), 'todo');
    const b = await body({
      slug: 'demo-plan',
      item: 'P-012',
      status: 'done',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].skipped).toBeUndefined();
    expect(reconcileMocks.findAllLinkedWorkItems).not.toHaveBeenCalled();
  });

  it('a lookup failure is fail-safe — the drop still proceeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reconcileMocks.findAllLinkedWorkItems.mockRejectedValue(new Error('pg unavailable'));
    lockReturnsMutatorValue(new Set(['P-012']));
    const b = await body({
      slug: 'demo-plan',
      item: 'P-012',
      status: 'dropped',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('dropped');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[plans:set-status] coverage guard'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});
