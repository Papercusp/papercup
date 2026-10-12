/**
 * degradation-watchdog against REAL Postgres, end to end through the condition rail
 * (degradation-signals-on-condition-rail-2026-10-11 P-003; BARs R-2 and R-8).
 *
 * WHY THIS FILE EXISTS. degradation-watchdog.test.ts proves the decision logic with
 * injected deps. It cannot prove the claims the plan actually rests on, because every
 * one of them is a property of the real rail:
 *
 *   1. A collapse recorded through `observeFallback` reaches the sweep through the real
 *      durable table and the real trailing-window reader.
 *   2. "One alarm per episode" holds across sweeps because the open key is read back
 *      from the durable condition fold (`readConditionEnvelopes` ->
 *      `computeConditionStates`), not from process memory. A faked
 *      `readOpenConditionKeys` would make this tautological.
 *   3. The acting consumer named in the signal-actor registry (R-8:
 *      `system:condition-bridge`) really acts: condition-staleness-alarm's tick, wired
 *      to the real `reconcileConditions`, mints exactly ONE owning work-item for the
 *      `degraded:` key, adopts it on the next tick, and settles it once the watchdog
 *      broadcasts recovery.
 *
 * Everything on that path is real. Only these seams are replaced:
 *   - `getOrgPg` routes to the throwaway DB's RLS-bypass admin client. work_items is
 *     workspace-RLS'd (migration 402) and this test is about the rail, not RLS.
 *   - `coordScopeWorkspace` is pinned so the bridge's work-items and coord links share
 *     one partition (same reasoning as condition-bridge.integration.test.ts).
 *   - `resolveWorkItemPot` is identity: the fresh DB registers no pots.
 *   - The operation-worker receipt read returns "none"; it fails closed on a fixture
 *     with no live sessions and is unrelated to the bridge.
 *   - The staleness tick's escalation and source-health legs are stubbed. They decide
 *     staleness reminders and infra/git-sync reconciliation, neither of which a fresh
 *     `degraded:` condition touches.
 *
 * Run with:
 *   npm run test:file -- packages/operator-core/lib/system-health/degradation-watchdog.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { recordGateReuseDecision } from '../../../../scripts/lib/test-pass-reuse.mjs';

const WS = 'ws-degradation-watchdog-it';
const H = 'papercusp';
const MECHANISM = 'gate-pass-reuse';
const SCOPE = 'lane-unit';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../agent-tools/coordination/log', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, coordScopeWorkspace: () => WS };
});
vi.mock('../pot-membership', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveWorkItemPot: async ({ rawSlug }: { rawSlug?: string | null }) => rawSlug ?? null,
  };
});
vi.mock('../blueprint/operation-worker-binding', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' }) };
});

// Imported AFTER the mocks are registered (vi.mock is hoisted).
const { observeFallback, flushFallbackObservations, _resetFallbackObservationsForTests } = await import(
  '../degradation/fallback-observations'
);
const { runDegradationSweepOnce, degradationConditionKey, getDegradationMechanism, _resetDegradationPruneClockForTests } =
  await import('./degradation-watchdog');
const { runConditionStalenessTick } = await import('./condition-staleness-alarm');
const { reconcileConditions } = await import('../coord/condition-bridge');
// Warm the stubbed receipt module before the first terminal transition imports it
// lazily (see the WI-10004742 note in condition-bridge.integration.test.ts).
await import('../blueprint/operation-worker-binding');

let db: OrgTestDb;
let coordination: BaselineCoordFixture | undefined;
let savedWsEnv: string | undefined;

/** The condition-staleness tick exactly as production wires it, minus the legs this test does not cover. */
function tick() {
  return runConditionStalenessTick({
    bridgeConditions: reconcileConditions,
    homeHarness: () => H,
    escalate: async () => undefined,
    listOpen: async () => [],
    resolve: async () => undefined,
    readHealthByKey: async () => new Map(),
    readGitSyncHealthByKey: async () => new Map(),
  });
}

async function observe(eligible: number, applied: number, reason: string): Promise<void> {
  expect(observeFallback(MECHANISM, { eligible, applied, reason, scope: SCOPE }, { workspaceId: WS })).toBe(true);
  const flushed = await flushFallbackObservations();
  expect(flushed).toMatchObject({ written: 1, failed: 0 });
}

/** Every work-item currently holding this condition key. */
async function holdersOf(key: string): Promise<string[]> {
  const rows = await db.adminSql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items WHERE condition_key = ${key} ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

/** Work-items minted for ANY degraded: key, with their status. */
async function degradedItems(): Promise<Array<{ feature_id: string; status: string; title: string }>> {
  return db.adminSql<Array<{ feature_id: string; status: string; title: string }>>`
    SELECT feature_id, status, title FROM harness_shared.work_items
     WHERE title LIKE ${'[degraded:%'} ORDER BY feature_id`;
}

/** Alarm envelopes (not resolutions) carrying this key on the coord message surface. */
async function alarmCount(key: string): Promise<number> {
  const [row] = await db.adminSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.coord_event_log
     WHERE surface = 'messages' AND body->>'condition_key' = ${key} AND NOT (body ? 'resolves_condition')`;
  return row.n;
}

beforeAll(async () => {
  savedWsEnv = process.env.PAPERCUSP_WORKSPACE_ID;
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  // Route every OTHER pool (app client, admin URL, withWorkspace) at the same throwaway DB.
  coordination = await setupBaselineCoordFixture({ dsn: db.adminDsn });
}, 300_000);

afterAll(async () => {
  try {
    await coordination?.dispose();
  } finally {
    await db?.cleanup();
    if (savedWsEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = savedWsEnv;
  }
}, 120_000);

beforeEach(async () => {
  _resetFallbackObservationsForTests();
  _resetDegradationPruneClockForTests();
  await db.adminSql`
    TRUNCATE harness_shared.fallback_observations, harness_shared.coord_event_log,
             harness_shared.coord_links, harness_shared.work_items RESTART IDENTITY CASCADE`;
});

describe('degradation watchdog on the real condition rail (R-2, R-8)', () => {
  it('P-004: shared full-suite/repair recorder, durable window and real bridge detect otherRunner collapse and settle recovery', async () => {
    const task = '@fixture/operator-core::test:lane-stateful';
    const key = degradationConditionKey(MECHANISM, task, 'otherRunner');
    const writer = { observeFallback, flushFallbackObservations };
    expect(await recordGateReuseDecision(task, { summary: { candidates: 100, reused: 0, otherRunner: 100 } }, writer)).toBe(true);
    expect((await runDegradationSweepOnce()).opened).toEqual([key]);
    expect((await runDegradationSweepOnce()).opened).toEqual([]);
    await tick();
    const items = await holdersOf(key);
    expect(items).toHaveLength(1);
    expect(await alarmCount(key)).toBe(1);
    // Both producers use the same task scope, so later successful primary decisions
    // recover its existing episode rather than creating a separate round-specific key.
    expect(await recordGateReuseDecision(task, { summary: { candidates: 200, reused: 200 } }, writer)).toBe(true);
    expect((await runDegradationSweepOnce()).resolved).toEqual([key]);
    await tick();
    expect(await holdersOf(key)).toEqual([]);
    expect((await degradedItems()).map((row) => row.feature_id)).toEqual(items);
    expect(ANY_FAMILY_TERMINAL_STATES).toContain((await degradedItems())[0].status);
  }, 180_000);

  it('the seed mechanism is registered scope-keyed, so this test exercises the shipped registration', () => {
    expect(getDegradationMechanism(MECHANISM)).toMatchObject({ mechanism: MECHANISM, scopeKeyed: true });
  });

  it('collapse opens ONE degraded: condition, the bridge mints ONE owning item, recovery settles it', async () => {
    const key = degradationConditionKey(MECHANISM, SCOPE, 'proofs-unavailable');
    expect(key).toBe(`degraded:${MECHANISM}:${SCOPE}:proofs-unavailable`);

    // ── Collapse: 40 eligible, 0 applied, one dominant reason ──
    await observe(40, 0, 'proofs-unavailable');

    const s1 = await runDegradationSweepOnce();
    expect(s1.errors).toEqual([]);
    expect(s1.evaluated).toContainEqual({ mechanism: MECHANISM, scope: SCOPE, verdict: 'collapsed' });
    expect(s1.opened).toEqual([key]);

    // Two more sweeps over the same collapsed window: the open key comes back from
    // the durable fold, so neither re-alarms nor resolves.
    for (let i = 0; i < 2; i++) {
      const again = await runDegradationSweepOnce();
      expect(again.errors).toEqual([]);
      expect(again.opened).toEqual([]);
      expect(again.resolved).toEqual([]);
    }
    expect(await alarmCount(key)).toBe(1);

    // The alarm declared itself one-shot, so the staleness guard will not read the
    // deliberate silence after it as recovery.
    const [alarm] = await db.adminSql<{ body: Record<string, unknown> }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE surface = 'messages' AND body->>'condition_key' = ${key}`;
    expect(alarm.body).toMatchObject({ condition_key: key, one_shot: true, category: 'degradation' });

    // ── The acting consumer acts (R-8): one owning item, adopted on the next tick ──
    const t1 = await tick();
    const mint = t1.bridged.acquired.find((a) => a.conditionKey === key);
    expect(mint, JSON.stringify(t1.bridged)).toMatchObject({ created: true });
    const wi = mint!.workItem!;
    expect(await holdersOf(key)).toEqual([wi]);

    const t2 = await tick();
    expect(t2.bridged.acquired.find((a) => a.conditionKey === key)).toMatchObject({ workItem: wi, created: false });
    const open = await degradedItems();
    expect(open.map((r) => r.feature_id)).toEqual([wi]);
    expect(ANY_FAMILY_TERMINAL_STATES).not.toContain(open[0].status);
    expect(open[0].title).toContain(key);

    // ── Recovery: 200 applied of 200 more brings the window to 200/240 >= 0.5 ──
    await observe(200, 200, 'applied');
    const s4 = await runDegradationSweepOnce();
    expect(s4.errors).toEqual([]);
    expect(s4.evaluated).toContainEqual({ mechanism: MECHANISM, scope: SCOPE, verdict: 'recovered' });
    expect(s4.resolved).toEqual([key]);
    expect(s4.opened).toEqual([]);

    const t3 = await tick();
    expect(t3.bridged.released.find((r) => r.released === wi)).toMatchObject({ released: wi, settled: true });
    const [settled] = await degradedItems();
    expect(settled.feature_id).toBe(wi);
    expect(ANY_FAMILY_TERMINAL_STATES).toContain(settled.status);
    expect(await holdersOf(key)).toEqual([]);

    // A recovered window stays quiet: no re-open, no second item.
    const s5 = await runDegradationSweepOnce();
    expect(s5.opened).toEqual([]);
    await tick();
    expect((await degradedItems()).map((r) => r.feature_id)).toEqual([wi]);
  }, 180_000);

  it('negative control: 19 eligible units is insufficient evidence, so nothing opens and nothing is minted', async () => {
    await observe(19, 0, 'proofs-unavailable');
    const s = await runDegradationSweepOnce();
    expect(s.errors).toEqual([]);
    expect(s.evaluated).toContainEqual({ mechanism: MECHANISM, scope: SCOPE, verdict: 'insufficient' });
    expect(s.opened).toEqual([]);
    const t = await tick();
    expect(t.bridged.acquired).toEqual([]);
    expect(await degradedItems()).toEqual([]);
  }, 120_000);
});
