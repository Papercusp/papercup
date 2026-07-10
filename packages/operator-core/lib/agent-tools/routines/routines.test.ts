/**
 * routines.test.ts — routines:list + routines:set (live-configurability-audit P-002).
 *
 * Mocks getOrgPg/workspace/home-harness/cron + the control harness (separately covered), so no PG.
 * Asserts: list maps rows (cron from trigger_config, iso timestamps) · set is operator/architect-
 * gated · set requires cron|active · an invalid cron is rejected BEFORE any DB touch · pause
 * (active:false) runs through the harness · dryRun does not apply.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/routines/routines.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Declare the mock's PARAMETERS, not just its return: `vi.fn(async () => …)` is a
// zero-arg signature, so `sqlMock.mock.calls` types as `[][]` and `.flat()` collapses
// to `never[]`. Every `typeof v === 'string'` guard below then narrows `never` (which
// has no properties) and TS rejects `.startsWith` / `.includes` — 5 errors that had
// nothing to do with the assertions themselves. Typing the rest args as `unknown[]`
// gives `.flat()` an `unknown[]`, which those guards narrow correctly. (WI-3616 drive-by:
// these 5 were the entire operator-core typecheck overage, 228 vs baseline 224.)
const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'default' }));
vi.mock('../../harness/operator-home-harness', async (orig) => ({ ...(await orig<Record<string, unknown>>()), operatorHomeHarnessSlug: () => 'home-harness' }));
vi.mock('../../harness/routines/cron', async (orig) => ({ ...(await orig<Record<string, unknown>>()), computeNextFireAt: vi.fn(() => new Date('2030-01-01T00:00:00Z')) }));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import { computeNextFireAt } from '../../harness/routines/cron';
const cronM = vi.mocked(computeNextFireAt);

const listTool = (await import('./list')).default;
const setTool = (await import('./set')).default;

type Out = { content?: { text: string }[]; data?: unknown };
// routines:list returns a {data} envelope (context-trimming-tiers P-023);
// routines:set still self-serializes content[] — handle both.
const body = (o: unknown) => {
  const out = o as Out;
  return out.data !== undefined ? out.data : JSON.parse(out.content![0]!.text);
};

beforeEach(() => {
  vi.clearAllMocks();
  cronM.mockReturnValue(new Date('2030-01-01T00:00:00Z'));
  sqlMock.mockResolvedValue([]);
});

describe('routines:list', () => {
  it('maps rows (cron from trigger_config, iso timestamps)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */10 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date('2030-01-01T00:00:00Z'),
        last_fired_at: null,
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.count).toBe(1);
    expect(b.routines[0]).toMatchObject({ name: 'git-sync', cron: '0 */10 * * * *', active: true, lastFiredAt: null });
  });

  // EI-7242: `q` was previously not a recognized arg at all — zod silently
  // stripped it and the query ran unfiltered (the whole catalog came back).
  it('accepts a `q` free-text filter and passes it through as an ILIKE pattern (EI-7242)', async () => {
    await listTool.handler({ q: 'git-sync' } as never, { role: 'su' } as never);
    const flatArgs = sqlMock.mock.calls.flat();
    expect(flatArgs).toContain('%git-sync%');
  });

  it('omits the `q` filter (passes null) when not provided — no accidental narrowing', async () => {
    await listTool.handler({} as never, { role: 'su' } as never);
    const flatArgs = sqlMock.mock.calls.flat();
    expect(flatArgs.some((v) => typeof v === 'string' && v.startsWith('%') && v.endsWith('%'))).toBe(false);
  });
});

describe('routines:set', () => {
  it('rejects a role without operator-config write authority (e.g. bee)', async () => {
    await expect(
      setTool.handler({ name: 'git-sync', active: false } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
  });

  it('accepts the queen (operator-equivalent, EI-2204)', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(await setTool.handler({ name: 'git-sync', active: false } as never, { role: 'mug' } as never));
    expect(b).toMatchObject({ ok: true, applied: true });
  });

  it('requires cron, active, or triggerConfig', async () => {
    await expect(
      setTool.handler({ name: 'git-sync' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/requires cron, active, and\/or triggerConfig/i);
  });

  it('patches trigger_config (P-017) — merges the patch, preserves cron, ignores a cron key in the patch', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *', max_tasks: 8 }, active: true, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'bee-transcript-cap', triggerConfig: { max_tasks: 4, cron: 'EVIL' } } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    // The UPDATE wrote the merged trigger_config: the caps patch (max_tasks:4) applied, cron preserved
    // (0 */10) — the `cron: 'EVIL'` key in the patch was ignored (cron only via the validated arg).
    const wrote = sqlMock.mock.calls.some((c) =>
      c.some((v) => typeof v === 'string' && v.includes('"max_tasks":4') && v.includes('"cron":"0 */10') && !v.includes('EVIL')),
    );
    expect(wrote).toBe(true);
  });

  it('rejects an invalid cron before any DB touch', async () => {
    cronM.mockReturnValue(null);
    await expect(
      setTool.handler({ name: 'git-sync', cron: 'nope' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/invalid cron/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('pauses a routine (active:false) through the harness', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(await setTool.handler({ name: 'git-sync', active: false } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, applied: true, routine: 'home-harness/git-sync', verify: { ok: true } });
  });

  it('dryRun does not apply', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(
      await setTool.handler({ name: 'git-sync', active: false, dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
