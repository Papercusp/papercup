/**
 * spawn-child's op_status writer is permanently retired (P-071 / D-063,
 * P-068 / D-098, plan retire-mug-kettle-su-only-2026-08-09).
 *
 * `buildDefaultSpawnChildDeps().startPlan` is the promote-time entry to the
 * RETIRED plan operational axis: it wrote `op_status='started'` on a freshly
 * scaffolded child's seed plan so the DBOS frontier would dispatch its features
 * (`readFrontierFeatures` gates a plan-sourced feature on its plan being
 * `op_status='started'`) — the dispatcher tier that retires. su self-selection
 * never read that axis, so the refusal costs the child's features nothing.
 *
 * Two properties, and the second is the one that rots:
 *   1. RETIRED ⇒ no write at all (not "a write that no-ops").
 *   2. PERMANENT ⇒ the former tier flag cannot re-enable the write. The flag
 *      was deleted by P-068; keeping the old flag-store mock here makes an
 *      accidental resurrection of that escape hatch observable.
 *
 * This mocks `@papercusp/flags/server` rather than `pot/started`, deliberately:
 * mocking `mugKettleSystemEnabled` would prove only that spawn-child calls a
 * function, not that it is wired to the tier flag the retirement actually turns.
 * The fail-CLOSED case (flag store unreachable) is only reachable this way too.
 *
 * ⚠ PARTIAL-MOCK HAZARD (EI-20017608270017874): every factory below spreads the
 * real module and overrides ONE seam. Hand-listing exports breaks silently the
 * moment anything in this graph imports a sibling.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** The former tier flag's answer, per test. `null` ⇒ the flag store throws. */
const TIER = vi.hoisted(() => ({ on: false as boolean | null }));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: async (key: string) => {
    if (key === 'papercusp-mug-kettle-system') {
      if (TIER.on === null) throw new Error('flag store unreachable');
      return TIER.on;
    }
    return true;
  },
}));

/** PROOF-OF-NO-SIDE-EFFECT: every SQL the dep issues lands here. */
const SQL = vi.hoisted(() => ({ calls: [] as string[], rows: [] as unknown[] }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => {
    const tx = (strings: TemplateStringsArray | string[]) => {
      SQL.calls.push(Array.isArray(strings) ? strings.join('?') : String(strings));
      return Promise.resolve(SQL.rows);
    };
    return fn(tx);
  },
}));

/** Resolving the child's plan scope is itself a DB round-trip — count it, so
 *  "the retired path did no work" is provable, not merely "wrote no rows". */
const SCOPE = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../plans/source', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePlanScope: async () => {
    SCOPE.calls += 1;
    return { workspaceId: 'ws-test', harnessSlug: 'my-tool-cli' };
  },
}));

const { buildDefaultSpawnChildDeps } = await import('./spawn-child');

const startPlan = () =>
  buildDefaultSpawnChildDeps({
    importFeatures: async () => ({ ids: [], inserted: 0, updated: 0 }),
  }).startPlan('my-tool-cli', 'my-tool-cli-seed-2026-06-07');

beforeEach(() => {
  SQL.calls = [];
  SQL.rows = [];
  SCOPE.calls = 0;
  TIER.on = false;
});

describe('spawn-child startPlan — the retired op_status axis', () => {
  it('refuses with its OWN outcome, and performs no work at all', async () => {
    TIER.on = false;
    await expect(startPlan()).resolves.toBe('axis_retired');
    expect(SQL.calls, 'the retired path must not reach PG').toEqual([]);
    expect(SCOPE.calls, 'the refusal precedes even the scope lookup').toBe(0);
  });

  it('fails CLOSED when the flag store is unreachable', async () => {
    // An unreadable flag resolving to "axis live" would re-enter the retired
    // axis — the exact failure the gate exists to stop, arriving precisely when
    // the system is degraded.
    TIER.on = null;
    await expect(startPlan()).resolves.toBe('axis_retired');
    expect(SQL.calls).toEqual([]);
  });

  it('PERMANENT: an old flag-store ON answer cannot re-enable the write', async () => {
    TIER.on = true;
    SQL.rows = [{ op_status: 'started' }];
    await expect(startPlan()).resolves.toBe('axis_retired');
    expect(SQL.calls, 'permanent retirement must not reach PG').toEqual([]);
    expect(SCOPE.calls, 'permanent retirement precedes the scope lookup').toBe(0);
  });

  it('PERMANENT: missing rows cannot turn retirement into plan_not_found', async () => {
    // `plan_not_found` is only reachable on the removed live-axis path. Keep
    // the old empty-row fixture so a future reactivation cannot hide behind a
    // different result shape.
    TIER.on = true;
    SQL.rows = [];
    await expect(startPlan()).resolves.toBe('axis_retired');
    expect(SQL.calls).toEqual([]);
    expect(SCOPE.calls).toBe(0);
  });
});
