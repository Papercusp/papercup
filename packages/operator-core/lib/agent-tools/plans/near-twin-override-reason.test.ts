/** Portfolio P-007 / R-7: exercise the real plans:new handler and revision seam. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [{ planSlug: 'cache-retention-repair-2026-01-01', title: 'Cache retention repair', status: 'active', archived: false }],
  persisted: null as null | { body: string; rationale: string | undefined },
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => 'papercusp' }));
vi.mock('../_harness-scope', async original => ({
  ...(await original<typeof import('../_harness-scope')>()), harnessScopedCtx: (_: unknown, ctx: unknown) => ctx,
}));
vi.mock('./source', () => ({
  listPlanIndexRows: async () => state.rows,
  resolvePlanScope: async () => ({ workspaceId: 'test', harnessSlug: 'papercusp' }),
}));
vi.mock('./semantic-dedup', () => ({
  confirmSimilarPlans: async (_: unknown, similar: unknown[]) => ({ verdict: false, kept: similar, dropped: [] }),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => { throw new Error('unit fixture'); } }));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn() }));
vi.mock('../../harness/usage-emitters', () => ({ emitPlanAuthored: vi.fn() }));
vi.mock('../../modes/goal-context', () => ({ resolveGoalContext: vi.fn(async () => null), stampPlanGoalProvenance: vi.fn(async () => null) }));
vi.mock('./plan-verification-profile-stamp', () => ({
  resolveNewPlanVerificationProfile: async () => ({}), stampNewPlanVerificationProfile: vi.fn(),
}));
vi.mock('./revisions', () => ({
  planRevisionCapture: (_: unknown, _slug: string, rationale: string | undefined) => ({
    recorded: { current: null },
    afterWrite: async () => { if (state.persisted) state.persisted.rationale = rationale; },
  }),
}));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(async (_ctx, opts, mutate) => {
    const change = await mutate(null);
    state.persisted = { body: change.newBody, rationale: undefined };
    await opts.afterWrite?.();
    return { kind: 'applied', value: change.value, version: 1, scope: { workspaceId: 'test', harnessSlug: 'papercusp' } };
  }),
}));

import tool from './new';
import { withPlanLock } from './with-plan-lock';

const call = async (extra: Record<string, unknown> = {}) => {
  const result = await tool.handler({ slug: 'cache-retention-repair-v2', title: 'Cache retention repair',
    content: '## Phase 1\n\n- **P-001** `todo` Repair retention\n', ...extra } as never,
  { metadata: vi.fn() } as never);
  return JSON.parse(result.content.find(item => item.type === 'text')!.text);
};

beforeEach(() => { vi.clearAllMocks(); state.persisted = null; });

describe('R-7 — near-twin notice and stored override reason', () => {
  it('returns the matching open plan and writes nothing without an override', async () => {
    const result = await call();
    expect(result.error).toBe('similar_exists');
    expect(result.similar).toEqual(expect.arrayContaining([expect.objectContaining({ slug: state.rows[0]!.planSlug })]));
    expect(withPlanLock).not.toHaveBeenCalled();
    expect(state.persisted).toBeNull();
  });

  it.each([undefined, '', ' \n\t'])('refuses an override without a stated reason (%s)', async rationale => {
    expect((await call({ force: true, rationale })).error).toBe('override_reason_required');
    expect(withPlanLock).not.toHaveBeenCalled();
    expect(state.persisted).toBeNull();
  });

  it('persists the stated rationale through the first-revision writer', async () => {
    const rationale = 'A separate repair for the new storage engine; the matching plan covers the old engine.';
    expect((await call({ force: true, rationale })).ok).toBe(true);
    expect(withPlanLock).toHaveBeenCalledTimes(1);
    expect(state.persisted).toEqual({ body: expect.stringContaining('Repair retention'), rationale });
  });

  it('retains the goal alias, while an explicitly empty rationale cannot borrow it', async () => {
    expect((await call({ force: true, goal: 'Separate storage engine' })).ok).toBe(true);
    expect(state.persisted?.rationale).toBe('Separate storage engine');
    vi.clearAllMocks(); state.persisted = null;
    expect((await call({ force: true, rationale: '', goal: 'Fallback must not override an explicit empty reason' })).error)
      .toBe('override_reason_required');
    expect(withPlanLock).not.toHaveBeenCalled();
  });
});
