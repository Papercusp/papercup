/** Portfolio R-1: real decision/status handlers and production readiness wiring.
 * Only persistence, identity and unrelated post-write effects are replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanNowNote } from './now-note-store';

const state = vi.hoisted(() => ({
  body: '',
  note: null as PlanNowNote | null,
  noteWrites: 0,
  readPlan: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('../_harness-scope', async orig => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => 'papercusp' }));
vi.mock('./slug-scope', async orig => ({
  ...(await orig<typeof import('./slug-scope')>()),
  recoverHarnessFromSlugs: vi.fn(),
}));
vi.mock('./source', async orig => ({
  ...(await orig<typeof import('./source')>()),
  readPlanBySlug: state.readPlan,
  resolvePlanScope: async () => ({ workspaceId: 'ws-1', harnessSlug: 'papercusp' }),
}));
vi.mock('./draft-item-start-gate', () => ({ checkDraftItemStartGateLive: vi.fn(async () => null) }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (ctx: { uiClientId?: string } | null) => {
    if (ctx?.uiClientId) return { ownerId: ctx.uiClientId };
    throw new Error('no agent identity');
  },
}));
vi.mock('./with-plan-lock', () => ({ withPlanLock: vi.fn(), bumpUpdatedDate: (body: string) => body }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../plan-items/reconcile-linked-work-items', () => ({
  findAllLinkedWorkItems: vi.fn(async () => []),
  reconcileLinkedWorkItemsForPlanItem: vi.fn(async () => ({
    reconciled: [], skippedInFlight: [], skippedAlreadyTerminal: [], skippedUnprovenLink: [], skippedGatedState: [],
  })),
  resyncPlanItemLaneNow: vi.fn(async () => null),
  resyncDependentPlanItemLanesNow: vi.fn(async () => []),
}));
vi.mock('../../plan-items/convert', async orig => ({
  ...(await orig<typeof import('../../plan-items/convert')>()),
  findCoverageWorkItems: vi.fn(async () => []),
}));
vi.mock('../../plan-items/assignments', async orig => ({
  ...(await orig<typeof import('../../plan-items/assignments')>()),
  unassignItem: vi.fn(async () => null),
}));
vi.mock('./plan-drain-transition', () => ({
  planDrainTransitionMutationGated: async () => ({ newBody: null, value: { applied: false } }),
}));
vi.mock('./plan-item-events', () => ({ emitPlanItemDoneEvent: vi.fn() }));
vi.mock('../../harness/usage-emitters', () => ({ emitDecisionAdded: vi.fn() }));
vi.mock('../../carry-surface-provenance-stamp', async orig => ({
  ...(await orig<typeof import('../../carry-surface-provenance-stamp')>()),
  carryProvenanceFields: vi.fn(async () => ({})),
}));
vi.mock('../../release/frozen-repair-edit-marker', async orig => ({
  ...(await orig<typeof import('../../release/frozen-repair-edit-marker')>()),
  readFrozenRepairMarker: () => null,
}));
vi.mock('./decision-provenance-record', async orig => ({
  ...(await orig<typeof import('./decision-provenance-record')>()),
  resolveDecisionProvenance: async () => ({ ok: true, provenance: { kind: 'self-imposed' } }),
  recordDecisionProvenance: vi.fn(async () => null),
}));
vi.mock('../../acceptance-bar-contract-snapshot', async orig => ({
  ...(await orig<typeof import('../../acceptance-bar-contract-snapshot')>()),
  readAcceptanceBarContractSnapshot: state.snapshot,
}));

import addDecision from './add-decision';
import setStatus from './set-status';
import { withPlanLock } from './with-plan-lock';
import { parsePlan } from './parser';
import { BAR_READINESS_NOW_MARK, reevaluateBarReadinessOnScopeWrite } from './plan-scope-cascade';
import { defaultBarReadinessDeps } from './plan-scope-cascade-deps';

function fixture(status = 'todo', banner = '') {
  return `---\nslug: plan-a\nstatus: active\n---\n\n## Now\n\n**State:** ${banner}Building.\n\n**Next:** Finish the build.\n\n## Items\n\n- **P-001** \`${status}\` Implement the feature\n- **P-002** \`todo\` Independent acceptance grading\n\n## Decisions\n`;
}

const scope = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };
const close = async (item = 'P-001', status = 'done') =>
  (await setStatus.handler({ slug: 'plan-a', item, status,
    ...(status === 'dropped' ? { note: 'Intentionally removed from this fixture.' } : {}),
  } as never, {} as never) as { data: any }).data;

beforeEach(() => {
  vi.clearAllMocks();
  state.body = fixture();
  state.note = null;
  state.noteWrites = 0;
  state.snapshot.mockResolvedValue({ readiness: {
    state: 'blocked', codes: ['bar_snapshot_mapping_missing'],
    nextRepair: { code: 'bar_snapshot_mapping_missing', barKey: 'R-1', action: 'Map the bar.' },
  } });
  state.readPlan.mockImplementation(async () => ({
    parsed: parsePlan(state.body),
    row: { ...scope, planSlug: 'plan-a', items: parsePlan(state.body).items, nowNote: state.note },
  }));
  vi.mocked(withPlanLock).mockImplementation(async (_ctx, _opts, mutate) => {
    const result = await mutate(state.body, { nowNote: state.note } as never, scope);
    if (result.newBody !== null) state.body = result.newBody;
    if (result.nowNote) {
      state.note = result.nowNote;
      state.noteWrites += 1;
    }
    return { kind: result.nowNote ? 'applied' : 'ok', ...result, scope, filePath: 'plan-a.md' } as never;
  });
});

describe('R-1 — readiness at the last build close', () => {
  it.each(['', `${BAR_READINESS_NOW_MARK} (old verdict).\n\n`])(
    'adding a decision with an open build item neither writes nor refreshes readiness (%s)', async banner => {
      state.body = fixture('todo', banner);
      const oldNow = parsePlan(state.body).now;
      const result = (await addDecision.handler(
        { slug: 'plan-a', title: 'Keep the approach', body: 'Reuse the existing implementation path.' } as never,
        { ...scope, uiClientId: 'su-recorder', isSuperuser: true } as never,
      ) as { data: any }).data;
      expect(result).toMatchObject({ ok: true });
      expect(parsePlan(state.body).decisions).toHaveLength(1);
      expect(parsePlan(state.body).now).toEqual(oldNow);
      expect(state.snapshot).not.toHaveBeenCalled();
      expect(state.noteWrites).toBe(0);
    },
  );

  it('closing the last build item evaluates readiness once, with acceptance still open', async () => {
    const result = await close();
    expect(result).toMatchObject({ ok: true });
    expect(parsePlan(state.body).items.map(item => item.storedStatus)).toEqual(['done', 'todo']);
    expect(state.snapshot).toHaveBeenCalledTimes(1);
    expect(state.noteWrites).toBe(1);
    expect(state.note?.state).toContain(BAR_READINESS_NOW_MARK);
    expect(result.results[0].barReadiness.cause).toBe('last-build-item-closed');
    await close();
    expect(state.snapshot).toHaveBeenCalledTimes(1);
    expect(state.noteWrites).toBe(1);
  });

  it('does not evaluate an intermediate build close or a subsequent acceptance close', async () => {
    state.body = state.body.replace('## Decisions', '- **P-003** `blocked` Implement the second part\n\n## Decisions');
    await close();
    expect(state.snapshot).not.toHaveBeenCalled();
    await close('P-003');
    expect(state.snapshot).toHaveBeenCalledTimes(1);
    await close('P-002');
    expect(state.snapshot).toHaveBeenCalledTimes(1);
  });

  it.each(['todo', 'wip', 'blocked', 'needs-human'])('guards every scope-write cause with %s build work', async status => {
    state.body = fixture(status);
    for (const cause of ['decision-added', 'item-dropped', 'rubric-amended'] as const) {
      const result = await reevaluateBarReadinessOnScopeWrite(
        { ...scope, planSlug: 'plan-a', cause }, defaultBarReadinessDeps(null, 'su-recorder'),
      );
      expect(result).toMatchObject({ skipped: 'build-items-open', openBuildItems: ['P-001'], nowStamped: false });
    }
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.noteWrites).toBe(0);
    expect(state.readPlan).toHaveBeenCalledWith('plan-a', scope);
  });

  it('evaluates when the final build item is dropped', async () => {
    expect(await close('P-001', 'dropped')).toMatchObject({ ok: true });
    expect(state.snapshot).toHaveBeenCalledTimes(1);
    expect(state.noteWrites).toBe(1);
  });

  it('does not infer finished build work from a missing or failed plan read', async () => {
    for (const read of [() => Promise.resolve(null), () => Promise.reject(new Error('read failed'))]) {
      state.readPlan.mockImplementationOnce(read);
      const result = await reevaluateBarReadinessOnScopeWrite(
        { ...scope, planSlug: 'plan-a', cause: 'decision-added' }, defaultBarReadinessDeps(null, 'su-recorder'),
      );
      expect(result).toMatchObject({ state: null, nowStamped: false });
      expect(result.error).toBeTruthy();
    }
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.noteWrites).toBe(0);
  });

  it('does not stamp a stale readiness result after build work reopens', async () => {
    state.body = fixture('done');
    state.snapshot.mockImplementationOnce(async () => {
      state.body = fixture('wip');
      return { readiness: { state: 'blocked', codes: ['bar_snapshot_mapping_missing'], nextRepair: null } };
    });
    const result = await reevaluateBarReadinessOnScopeWrite(
      { ...scope, planSlug: 'plan-a', cause: 'decision-added' }, defaultBarReadinessDeps(null, 'su-recorder'),
    );
    expect(result.nowStamped).toBe(false);
    expect(state.noteWrites).toBe(0);
  });
});
