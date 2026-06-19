/**
 * set-schedule.test.ts — the plans:set-schedule handler's OWN logic: recurrence
 * validation, error-code mapping, the persisted-args shaping, and the `scheduled`
 * flag. These branches all run BEFORE the PG write, so we mock `./source`
 * (setPlanSchedule has no other test) and `./_ctx-opts` to keep this a fast,
 * deterministic unit test, while running the REAL validateRrule/frequencyWarning
 * (pure). A regression that flips the rrule/cron dispatch, drops a required-field
 * check, or mis-maps an error code is exactly what this pins.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/set-schedule.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./source', () => ({ setPlanSchedule: vi.fn(), getPlanRow: vi.fn() }));
vi.mock('./_ctx-opts', () => ({
  ctxToPlanSourceOpts: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })),
}));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));

import { setPlanSchedule } from './source';
const setSched = vi.mocked(setPlanSchedule);
const tool = (await import('./set-schedule')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const call = (args: Record<string, unknown>) =>
  tool.handler({ harness: 'web', slug: 'p1', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  setSched.mockReset();
  setSched.mockResolvedValue(true);
});

describe('plans:set-schedule validation (pre-PG branches)', () => {
  it('rejects kind=rrule with no rrule and does NOT write', async () => {
    const out = await call({ schedule: { kind: 'rrule' } });
    expect(out.isError).toBe(true);
    expect(body(out).error).toBe('rrule_required');
    expect(setSched).not.toHaveBeenCalled();
  });

  it('rejects an rrule that fails validateRrule (missing FREQ)', async () => {
    const out = await call({ schedule: { kind: 'rrule', rrule: 'BYDAY=MO,WE' } });
    expect(out.isError).toBe(true);
    const b = body(out);
    expect(b.error).toBe('invalid_rrule');
    expect(String(b.detail)).toMatch(/FREQ/i);
    expect(setSched).not.toHaveBeenCalled();
  });

  it('rejects kind=cron with no cron expression', async () => {
    const out = await call({ schedule: { kind: 'cron' } });
    expect(out.isError).toBe(true);
    expect(body(out).error).toBe('cron_required');
    expect(setSched).not.toHaveBeenCalled();
  });
});

describe('plans:set-schedule persistence + result shaping', () => {
  it('stores a valid RRULE, reports scheduled:true, and passes through the tzid', async () => {
    const out = await call({
      schedule: { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', tzid: 'America/New_York' },
    });
    expect(out.isError).toBeUndefined();
    const b = body(out);
    expect(b).toMatchObject({ ok: true, slug: 'p1', scheduled: true });
    expect(b.warnings).toBeUndefined(); // weekly is not "frequent" → no warn
    expect(setSched).toHaveBeenCalledTimes(1);
    const arg = setSched.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.slug).toBe('p1');
    expect(arg.tzid).toBe('America/New_York'); // resolved from schedule.tzid
    expect((arg.schedule as { rrule: string }).rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
  });

  it('maps a falsy write to not_found', async () => {
    setSched.mockResolvedValue(false);
    const out = await call({ schedule: { kind: 'rrule', rrule: 'FREQ=DAILY' } });
    expect(out.isError).toBe(true);
    expect(body(out).error).toBe('not_found');
  });

  it('clears the schedule (schedule:null) → scheduled:false, write gets schedule:null', async () => {
    const out = await call({ schedule: null, scheduledAt: null });
    const b = body(out);
    expect(b).toMatchObject({ ok: true, scheduled: false });
    expect((setSched.mock.calls[0]![0] as Record<string, unknown>).schedule).toBeNull();
  });

  it('a one-shot scheduledAt (no recurrence) still reports scheduled:true', async () => {
    const out = await call({ schedule: null, scheduledAt: '2026-07-01T00:00:00Z' });
    expect(body(out)).toMatchObject({ ok: true, scheduled: true });
  });
});
