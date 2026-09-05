/**
 * arm-schedule.test.ts — the plans:arm-schedule HANDLER guard chain (armPlanSchedule
 * is mocked). Arming makes a plan start FIRING runs autonomously, so its guards are
 * load-bearing and ordered:
 *   1. feature flag off → feature_disabled (no arm);
 *   2. unknown plan → not_found;
 *   3. plan has no schedule AND no scheduledAt → not_scheduled (author one first);
 *   4. armPlanSchedule failure → its reason is surfaced;
 *   5. success → routineId + nextFireAt.
 * A regression that arms a never-scheduled plan, or ignores the feature flag, is what
 * this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/arm-schedule.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('./source', () => ({ getPlanRow: vi.fn() }));
vi.mock('../../harness/routines/arm-plan-schedule', () => ({ armPlanSchedule: vi.fn() }));

import { getFlag } from '@papercusp/flags/server';
import { configurePlanAdmissionPolicySource } from './plan-admission-gate';
// P-004 admission: checkPlanStartable now ends in checkPlanAdmission, whose default
// policy source reads the pot's governance section through hive-federation →
// harness-registry → PG. A unit test has no PG, so pin the source to "no policy"
// (admitted, skipped:'no-admission-policy') through the gate's own seam.
configurePlanAdmissionPolicySource(async () => null);
import { getPlanRow } from './source';
import { armPlanSchedule } from '../../harness/routines/arm-plan-schedule';
const flagM = vi.mocked(getFlag);
const getRow = vi.mocked(getPlanRow);
const armM = vi.mocked(armPlanSchedule);
const tool = (await import('./arm-schedule')).default;

type Out = { data?: any; content?: { text: string }[]; isError?: boolean };
const call = (slug = 'p1') => tool.handler({ harness: 'web', slug } as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data ?? JSON.parse(o.content![0]!.text);

const scheduledPlan = { workspaceId: 'default', harnessSlug: 'web', schedule: { rrule: 'FREQ=DAILY' }, scheduledAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  flagM.mockResolvedValue(true);
  getRow.mockResolvedValue(scheduledPlan as never);
  armM.mockResolvedValue({ ok: true, routineId: 'r1', nextFireAt: 't1' } as never);
});

describe('plans:arm-schedule guard chain', () => {
  it('refuses when the scheduled-plans flag is off', async () => {
    flagM.mockResolvedValue(false);
    const b = body(await call());
    expect(b.results[0].error).toBe('feature_disabled');
    expect(armM).not.toHaveBeenCalled();
  });

  it('not_found for an unknown plan', async () => {
    getRow.mockResolvedValue(null as never);
    expect(body(await call()).results[0].error).toBe('not_found');
    expect(armM).not.toHaveBeenCalled();
  });

  it('not_scheduled when the plan has neither schedule nor scheduledAt', async () => {
    getRow.mockResolvedValue({ workspaceId: 'default', harnessSlug: 'web', schedule: null, scheduledAt: null } as never);
    expect(body(await call()).results[0].error).toBe('not_scheduled');
    expect(armM).not.toHaveBeenCalled();
  });

  it('surfaces an armPlanSchedule failure reason', async () => {
    armM.mockResolvedValue({ ok: false, reason: 'already_armed' } as never);
    expect(body(await call()).results[0].error).toBe('already_armed');
  });

  it('arms and returns routineId + nextFireAt', async () => {
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true, slug: 'p1', routineId: 'r1', nextFireAt: 't1' }] });
    expect(armM.mock.calls[0]![0]).toMatchObject({ workspaceId: 'default', harnessSlug: 'web', templateSlug: 'p1' });
  });

  it('arms selected slugs as a keyed batch', async () => {
    const r = (await tool.handler({ harness: 'web', slugs: ['p1', 'p2'] } as never, {} as never)) as Out;
    const b = body(r);
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((x: any) => x.slug)).toEqual(['p1', 'p2']);
    expect(armM).toHaveBeenCalledTimes(2);
  });
});
