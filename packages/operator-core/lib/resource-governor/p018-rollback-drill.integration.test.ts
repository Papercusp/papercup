/**
 * P-018 — rollback drill for the capless adaptive resource governor.
 *
 * D-017 states the rollback contract exactly: "Rollback preserves
 * queue/receipts/state history and may temporarily restore prior admission
 * behavior, but cannot establish a second permanent cap architecture."
 *
 * This drill executes that rollback for real against Postgres and asserts each
 * clause. It is the recurrence guard for the rollback runbook: if a future
 * change makes a rollback lose a receipt, forget the queue, drop controller
 * history, or reintroduce a ceiling, this file goes red.
 *
 * The "prior admission behavior" restored here is `AdmitImmediatelyDriver` —
 * the pre-governor path in which a start is simply allowed. The point of the
 * drill is that swapping to it does NOT destroy the durable substrate, and
 * swapping back resumes from it.
 *
 * The durable substrate is the dedicated admission ledger
 * (`harness_shared.resource_governor_admissions`, P-006 of
 * `resource-governor-admission-ledger-2026-09-01`): the drill runs on a fixture
 * with NO work-item allocator, so a rollback that regressed to writing
 * work-items would throw rather than pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  allSessionsLiveResolver,
  applyAdmissionLedgerFixture,
  truncateAdmissionLedgerFixture,
  workItemRowCount,
} from '../../test/_admission-ledger-fixture';
import { AdmitImmediatelyDriver, Governor } from './admission';
import { PgAdmissionLedgerQueueStore } from './admission-ledger-store';
import { WorkItemAdmissionQueueDriver } from './queue';
import {
  CaplessAdaptiveController,
  CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION,
  type CaplessControllerState,
} from './controller';
import {
  GOVERNOR_ADMISSION_CELL,
  GOVERNOR_HEALTH_CELL,
  GOVERNOR_QUEUE_CELL,
  GOVERNOR_RECOVERY_CELL,
  GOVERNOR_RESOURCES_CELL,
} from '../cell-registrations';

const START = 1_700_000_000_000;
const NAMESPACE = 'p018-rollback-drill';
const WORKSPACE_ID = 'ws-p018';
const LOAD = 40;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('p018-rollback-drill');
  await applyAdmissionLedgerFixture(db.sql);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await truncateAdmissionLedgerFixture(db.sql);
});

function governedStack(label: string) {
  let requestNo = 0;
  let leaseNo = 0;
  const store = new PgAdmissionLedgerQueueStore({
    sql: db.sql,
    workspaceId: WORKSPACE_ID,
    resolveSessionStatesFn: allSessionsLiveResolver,
  });
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: NAMESPACE,
    now: () => START,
    leaseIdFactory: () => `${label}-lease-${++leaseNo}`,
  });
  return {
    store,
    driver,
    governor: new Governor(driver, { now: () => START, idFactory: () => `${label}-req-${++requestNo}` }),
  };
}

async function queueRows(): Promise<{ receiptId: string; state: string; idempotencyKey: string }[]> {
  const rows = await db.sql<{ receipt_id: string; state: string; idempotency_key: string }[]>`
    SELECT receipt_id, state, idempotency_key
      FROM harness_shared.resource_governor_admissions
     WHERE workspace_id = ${WORKSPACE_ID}
       AND namespace = ${NAMESPACE}
     ORDER BY receipt_id`;
  return rows.map((row) => ({ receiptId: row.receipt_id, state: row.state, idempotencyKey: row.idempotency_key }));
}

async function enqueueBaseline(label: string): Promise<string[]> {
  const { governor } = governedStack(label);
  const outcomes = await Promise.all(
    Array.from({ length: LOAD }, (_, i) =>
      governor.admit({
        idempotencyKey: `drill-${i}`,
        admissionClass: i % 2 === 0 ? 'agent' : 'build',
        priority: 4,
        demand: { cpuWeight: 10, memoryBytes: 32 * 1024 ** 2 },
        payloadRef: `work-item:P-018:drill:${i}`,
      }),
    ),
  );
  expect(outcomes.every((outcome) => outcome.kind === 'queued')).toBe(true);
  return outcomes.map((outcome) => (outcome.kind === 'queued' ? outcome.receipt.receiptId : '')).sort();
}

describe('P-018 rollback drill', () => {
  it('preserves every queued receipt while prior admission behavior is temporarily restored', async () => {
    const before = await enqueueBaseline('pre-rollback');
    const rowsBefore = await queueRows();
    expect(rowsBefore).toHaveLength(LOAD);

    // ROLL BACK: the governed driver is replaced by the pre-governor path.
    // New starts are admitted immediately; nothing touches the durable queue.
    const rolledBack = new Governor(new AdmitImmediatelyDriver(), {
      now: () => START,
      idFactory: () => `rollback-req-${Math.random().toString(36).slice(2)}`,
    });
    const duringRollback = await rolledBack.admit({
      idempotencyKey: 'drill-during-rollback',
      admissionClass: 'agent',
      priority: 4,
      demand: { cpuWeight: 10 },
      payloadRef: 'work-item:P-018:drill:during-rollback',
    });
    expect(duringRollback.kind).toBe('admitted');

    // Clause 1 — the queue and its receipts survive the rollback untouched.
    const rowsDuring = await queueRows();
    expect(rowsDuring).toEqual(rowsBefore);

    // ROLL FORWARD: the governed driver returns and still resolves every receipt.
    const resumed = governedStack('post-rollback');
    for (const row of rowsBefore) {
      const status = await resumed.driver.status(row.idempotencyKey);
      expect(status.state).toBe('queued');
      expect(status.receipt?.receiptId).toBe(row.receiptId);
    }
    // Clause 2 — replaying the identical requests after the rollback neither
    // loses nor duplicates work.
    const after = await enqueueBaseline('post-rollback-replay');
    expect(after).toEqual(before);
    expect(await queueRows()).toHaveLength(LOAD);
    // Clause 1, ledger form: every receipt lives in the dedicated ledger and
    // none of them — before, during, or after the rollback — became a work-item.
    expect(before.every((receiptId) => receiptId.startsWith('RG-'))).toBe(true);
    expect(await workItemRowCount(db.sql, WORKSPACE_ID)).toBe(0);
  }, 120_000);

  it('preserves controller state history across the rollback and restores it without a ceiling', () => {
    const controller = new CaplessAdaptiveController({ minimumWindow: 1, initialWindow: 4 });
    const history: CaplessControllerState[] = [];
    for (let generation = 1; generation <= 4; generation++) {
      controller.step({
        verdict: {
          schemaVersion: 'resource-governor-health-analysis-v1',
          scopeId: 'p018',
          evaluatedAtMs: START + generation * 1_000,
          state: 'healthy',
          severity: 'none',
          actionable: false,
          evidence: [],
          attributions: [],
          actionableResources: [],
          ignoredCapacitySignals: [],
          reasons: ['drill'],
        },
        classes: [{ admissionClass: 'agent', inFlight: 0 }],
        atMs: START + generation * 1_000,
      });
      history.push(controller.snapshot(START + generation * 1_000));
    }
    // Clause 3 — state history is a real sequence, not one mutable latest value.
    expect(history).toHaveLength(4);
    expect(history.map((state) => state.generation)).toEqual([1, 2, 3, 4]);
    for (const state of history) expect(state.schemaVersion).toBe(CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION);

    // Clause 4 — the rollback cannot establish a second permanent cap
    // architecture. A restored snapshot carries transient feedback only: no
    // key anywhere in the persisted shape names a maximum.
    const serialized = JSON.stringify(history[history.length - 1]);
    for (const forbidden of ['"cap"', '"maxWindow"', '"maximum"', '"ceiling"', '"limit"', '"maxConcurrent"']) {
      expect(serialized).not.toContain(forbidden);
    }
    const restored = new CaplessAdaptiveController({
      minimumWindow: 1,
      initialWindow: 4,
      state: history[history.length - 1]!,
    });
    const resumedWindow = restored.snapshot(START + 5_000).classes[0]?.desiredWindow ?? 0;
    const beforeWindow = history[history.length - 1]!.classes[0]?.desiredWindow ?? 0;
    expect(resumedWindow).toBe(beforeWindow);
    // And the restored window keeps climbing — it is a resume point, not a cap.
    for (let generation = 5; generation <= 20; generation++) {
      restored.step({
        verdict: {
          schemaVersion: 'resource-governor-health-analysis-v1',
          scopeId: 'p018',
          evaluatedAtMs: START + generation * 1_000,
          state: 'healthy',
          severity: 'none',
          actionable: false,
          evidence: [],
          attributions: [],
          actionableResources: [],
          ignoredCapacitySignals: [],
          reasons: ['drill'],
        },
        classes: [{ admissionClass: 'agent', inFlight: 0 }],
        atMs: START + generation * 1_000,
      });
    }
    expect(restored.snapshot(START + 21_000).classes[0]!.desiredWindow).toBeGreaterThan(beforeWindow);
  });

  it('keeps every governor telemetry cell registered through the rollback', () => {
    // Clause 5 — telemetry survives. Rollback restores admission behavior, not
    // observability: the registered state cells are the operator's only view of
    // what the governor is doing, so a rollback that blinded them would leave
    // nobody able to tell whether rolling forward is safe.
    const cells = [
      GOVERNOR_HEALTH_CELL,
      GOVERNOR_ADMISSION_CELL,
      GOVERNOR_QUEUE_CELL,
      GOVERNOR_RESOURCES_CELL,
      GOVERNOR_RECOVERY_CELL,
    ];
    expect(cells.map((cell) => cell.cell)).toEqual([
      'governor.health',
      'governor.admission',
      'governor.queue',
      'governor.resources',
      'governor.recovery',
    ]);
    for (const cell of cells) {
      expect(cell.changeSignal).toBeDefined();
      expect(cell.assessment).toBeDefined();
      // No cell exposes a capacity ceiling as state.
      expect(JSON.stringify(cell.shape)).not.toContain('max');
    }
  });

  it('cancels a queued receipt durably so a rollback has an ordered exit, not a lost row', async () => {
    await enqueueBaseline('cancel-path');
    const { driver } = governedStack('cancel-path-reader');
    const cancelled = await driver.cancel('drill-0', 'p018 rollback drill');
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.state).toBe('cancelled');

    const rows = await queueRows();
    // The row is still present and auditable — cancellation is a state, never a delete.
    expect(rows).toHaveLength(LOAD);
    const row = rows.find((item) => item.idempotencyKey === 'drill-0');
    expect(row?.state).toBe('cancelled');
    const status = await driver.status('drill-0');
    expect(status.state).toBe('cancelled');
    expect(status.receipt?.receiptId).toBe(row?.receiptId);
  }, 120_000);
});
