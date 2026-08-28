import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ register: vi.fn(), failOpen: vi.fn() }));
vi.mock('./system-actions', () => ({ registerSystemAction: h.register }));
vi.mock('../../work-items-admission-promoter', async (orig) => {
  const actual = await orig<typeof import('../../work-items-admission-promoter')>();
  return { ...actual, runWorkItemAdmissionFailOpen: h.failOpen };
});

const { makeWorkItemAdmissionFailOpenAction, makeWorkItemAdmissionPromoterAction } =
  await import('./work-item-admission-promoter-action');
const registeredNames = h.register.mock.calls.map((call) => call[0]);

const ctx = {
  installSlug: 'papercusp',
  workspaceId: 'ws',
  triggerConfig: {},
  payloadTemplate: null,
};

beforeEach(() => vi.clearAllMocks());

describe('work-item admission routine actions', () => {
  it('registers the LLM promoter and the independent fail-open action', () => {
    expect(registeredNames).toEqual(['work-item-admission-promoter', 'work-item-admission-fail-open']);
  });

  it('runs and reports one promoter tick', async () => {
    const log = vi.fn();
    const alarm = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({
      runId: 'p1',
      batchSize: 6,
      flaggedPairs: 5,
      promoted: 1,
      merged: 5,
      held: 0,
      modelCalled: true,
      tokensIn: 100,
      tokensOut: 20,
      censusBefore: 5,
      censusAfter: 0,
    }));
    await makeWorkItemAdmissionPromoterAction({ run, alarm, invalidate, log })(ctx);
    expect(run).toHaveBeenCalledWith(ctx);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(alarm).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('promoted=1 merged=5 held=0'));
  });

  it('raises the durable census alarm only when the unadjudicated census rises', async () => {
    const alarm = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => undefined);
    const base = {
      runId: 'p-rise',
      batchSize: 1,
      flaggedPairs: 1,
      promoted: 0,
      merged: 0,
      held: 1,
      modelCalled: true,
      tokensIn: 10,
      tokensOut: 2,
      censusBefore: 4,
      censusAfter: 5,
    };
    await makeWorkItemAdmissionPromoterAction({
      run: async () => base,
      alarm,
      invalidate,
      log: vi.fn(),
    })(ctx);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(alarm).toHaveBeenCalledWith(ctx, base);

    alarm.mockClear();
    await makeWorkItemAdmissionPromoterAction({
      run: async () => ({ ...base, censusAfter: 4 }),
      alarm,
      invalidate,
      log: vi.fn(),
    })(ctx);
    expect(alarm).not.toHaveBeenCalled();
  });

  // WIRING GUARD. The core supports both scopes, so the only thing standing between a healthy
  // fleet and every non-home harness starving forever is this one argument on the production
  // path. Without this test, deleting it keeps all other tests green and silently restores the
  // 40.7h starvation measured 2026-08-28 (WI-569147).
  it('asks for a workspace-wide sweep on the production fail-open path', async () => {
    h.failOpen.mockResolvedValue({
      runId: 'f-prod',
      autoPromoted: [],
      autoPromotedByHarness: {},
      scope: 'workspace',
      liveness: {
        stale: false,
        reason: 'healthy',
        active: true,
        routineExists: true,
        lastSuccessAtMs: 1,
        ageMs: 1,
        thresholdMs: 90,
      },
    });

    // deliberately NOT overriding `run` — this exercises the real productionFailOpen wiring
    await makeWorkItemAdmissionFailOpenAction({
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log: vi.fn(),
    })(ctx);

    expect(h.failOpen).toHaveBeenCalledTimes(1);
    expect(h.failOpen.mock.calls[0]![0]).toMatchObject({ scope: 'workspace', workspaceId: 'ws' });
  });

  it('raises the liveness alarm only on a stale fail-open verdict', async () => {
    const alarm = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => undefined);
    const stale = {
      runId: 'f1',
      autoPromoted: ['WI-1'],
      autoPromotedByHarness: { papercusp: ['WI-1'] },
      scope: 'workspace' as const,
      liveness: {
        stale: true,
        reason: 'no successful tick',
        active: true,
        routineExists: true,
        lastSuccessAtMs: 1,
        ageMs: 100,
        thresholdMs: 90,
      },
    };
    await makeWorkItemAdmissionFailOpenAction({ run: async () => stale, alarm, invalidate, log: vi.fn() })(ctx);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(alarm).toHaveBeenCalledWith(ctx, stale);

    alarm.mockClear();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => ({ ...stale, liveness: { ...stale.liveness, stale: false } }),
      alarm,
      invalidate,
      log: vi.fn(),
    })(ctx);
    expect(alarm).not.toHaveBeenCalled();
  });
});
