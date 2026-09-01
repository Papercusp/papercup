/**
 * P-007 (plan `nonblocking-test-materializer-2026-08-28`, decision D-002).
 *
 * The one gap D-002 identified: MEASURED actual-demand release. The chain is
 *
 *   sampler peak -> settle -> execution.finish(actualDemand)
 *                          -> governor.release -> durable Postgres receipt
 *
 * and both ENDS were already covered while the MIDDLE was not. P-006's unit
 * suite (`lib/__tests__/governed-test-process.test.ts`) injects a stub
 * `executionApi`, so it never reaches a governor or a database.
 * `queue.integration.test.ts` persists an exact actual-cost release, but from a
 * hand-supplied `{ databaseConnections: 3 }` — never from a measurement.
 *
 * So nothing proved that a real sampler peak, taken from a real child process
 * through real procfs, reaches the durable receipt. That gap matters because
 * the miss is SILENT by construction: `createGovernedProcessDemandSampler`
 * settles as `memoryBytes: extra ?? peakRss ?? planned?.memoryBytes`, so a run
 * whose measurement failed writes the PLANNED RESERVATION into the receipt and
 * is indistinguishable, in the durable row, from one that measured correctly.
 * A governor learning reservations it invented is not learning anything.
 *
 * These tests therefore use the REAL bridge, the REAL execution seam, the REAL
 * governor and a REAL Postgres receipt. Only the database CONNECTION is
 * substituted (a throwaway test database instead of the ambient runtime), which
 * is the single seam an integration test must own.
 *
 * The durable receipt is a row of the dedicated admission ledger
 * (`harness_shared.resource_governor_admissions`, P-006 of
 * `resource-governor-admission-ledger-2026-09-01`); the fixture carries no
 * work-item allocator, so a release that regressed to a work-item projection
 * would throw here rather than pass.
 */
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  allSessionsLiveResolver,
  applyAdmissionLedgerFixture,
  truncateAdmissionLedgerFixture,
  workItemRowCount,
} from '../../test/_admission-ledger-fixture';
import type { AdmissionContext, ResourceDemand } from './admission';
import { Governor } from './admission';
import { PgAdmissionLedgerQueueStore } from './admission-ledger-store';
import {
  admissionContextFromEnvironment,
  governedExecutionLeaseTtlForTimeout,
  withGovernedExecution,
  type GovernedExecutionDeps,
} from './execution';
import { WorkItemAdmissionQueueDriver } from './queue';
import {
  classifyGovernedTestProcessOutcome,
  createGovernedProcessDemandSampler,
  runGovernedTestProcess,
} from '../../../../scripts/lib/governed-test-process.mjs';

const WORKSPACE_ID = 'ws-governed-process';

/**
 * The child holds a quarter-gigabyte resident. The planned reservation is set
 * two orders of magnitude BELOW that on purpose: the assertions then separate
 * "measured" from "fell back to planned" by a margin no scheduling noise, GC
 * timing or page-cache accounting can close.
 */
const HELD_BLOCK_BYTES = 256 * 1024 * 1024;
const PLANNED_MEMORY_BYTES = 4 * 1024 * 1024;
/** A bare Node process is already well past this, so it never flakes upward. */
const MEASURED_FLOOR_BYTES = 64 * 1024 * 1024;

const PLANNED: ResourceDemand = {
  cpuWeight: 1,
  memoryBytes: PLANNED_MEMORY_BYTES,
  diskBytes: 8 * 1024 * 1024,
  fileDescriptors: 8,
};

/**
 * Hold a large buffer resident, then exit with a trustworthy verdict.
 * `globalThis` retains it so V8 cannot collect the block before it is sampled,
 * and the length re-check keeps that retention honest rather than decorative.
 */
const trustworthyChild = (holdMs: number): string => `
const block = Buffer.alloc(${HELD_BLOCK_BYTES});
block.fill(7);
globalThis.__hold = block;
process.stdout.write("holding\\n");
setTimeout(() => {
  if (globalThis.__hold.length !== ${HELD_BLOCK_BYTES}) process.exit(3);
  process.stdout.write("Tests 1 passed\\n");
  process.exit(0);
}, ${holdMs});
`;

/**
 * Same residency, but exits the way a crashed Vitest worker does. The memory is
 * deliberately real: the run HAS a measurement, and the point of the test is
 * that the measurement is discarded rather than persisted.
 */
const untrustworthyChild = (holdMs: number): string => `
const block = Buffer.alloc(${HELD_BLOCK_BYTES});
block.fill(7);
globalThis.__hold = block;
process.stdout.write("holding\\n");
setTimeout(() => {
  process.stderr.write("worker exited unexpectedly\\n");
  process.exit(1);
}, ${holdMs});
`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('governed-test-process-demand');
  await applyAdmissionLedgerFixture(db.sql);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await truncateAdmissionLedgerFixture(db.sql);
});

function governedDeps(): GovernedExecutionDeps {
  let leaseNo = 0;
  const store = new PgAdmissionLedgerQueueStore({
    sql: db.sql,
    workspaceId: WORKSPACE_ID,
    resolveSessionStatesFn: allSessionsLiveResolver,
  });
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'integration-test-process',
    leaseIdFactory: () => `governed-lease-${++leaseNo}`,
  });
  return { driver, governor: new Governor(driver) };
}

/**
 * Mirrors the real `runGovernedOperation` mapping exactly, substituting only
 * the deps. Copying the field-for-field shape is deliberate: a shim that
 * "simplified" the mapping would be testing the shim, not the seam.
 */
function testExecutionApi(deps: GovernedExecutionDeps) {
  return {
    admissionContextFromEnvironment,
    governedExecutionLeaseTtlForTimeout,
    runGovernedOperation: <T>(
      input: {
        readonly owner: string;
        readonly admissionClass: string;
        readonly idempotencyKey: string;
        readonly demand?: ResourceDemand;
        readonly leaseTtlMs?: number;
        readonly metadata?: Readonly<Record<string, unknown>>;
        readonly settle?: GovernedExecutionSettleFn<T>;
        readonly measureActualDemand?: () => ResourceDemand | undefined;
      },
      run: (context: AdmissionContext) => Promise<T>,
    ): Promise<T> =>
      withGovernedExecution<T>(
        {
          idempotencyKey: input.idempotencyKey,
          admissionClass: input.admissionClass,
          demand: input.demand,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        } as Parameters<typeof withGovernedExecution<T>>[0],
        {
          owner: input.owner,
          ...(input.leaseTtlMs != null ? { leaseTtlMs: input.leaseTtlMs } : {}),
          ...(input.settle ? { settle: input.settle } : {}),
          ...(input.measureActualDemand ? { measureActualDemand: input.measureActualDemand } : {}),
        },
        deps,
        run,
      ),
  };
}

type GovernedExecutionSettleFn<T> = (
  result: T,
  context: AdmissionContext,
) =>
  | { readonly kind: 'release'; readonly actualDemand?: ResourceDemand }
  | { readonly kind: 'cancel'; readonly reason: string }
  | Promise<
      | { readonly kind: 'release'; readonly actualDemand?: ResourceDemand }
      | { readonly kind: 'cancel'; readonly reason: string }
    >;

interface GovernedChildRun {
  readonly receiptId: string;
  readonly measured: ResourceDemand;
  readonly exitCode: number | null;
}

/**
 * Drive one real child through the real bridge, wired exactly as
 * `scripts/affected-tests.mjs` and `scripts/test-files.mjs` wire it:
 * create the sampler, attach it to the spawned pid, and hand
 * `sampler.stop()` to `classifyGovernedTestProcessOutcome` as the outcome's
 * `actualDemand`.
 */
async function runGovernedChild(options: {
  readonly idempotencyKey: string;
  readonly script: string;
  readonly deps: GovernedExecutionDeps;
}): Promise<GovernedChildRun> {
  let receiptId: string | undefined;
  let measured: ResourceDemand | undefined;
  let exitCode: number | null = null;

  await runGovernedTestProcess(
    {
      workspaceId: WORKSPACE_ID,
      namespace: 'integration-test-process',
      owner: 'p007-governed-child',
      admissionClass: 'process',
      demand: PLANNED,
      idempotencyKey: options.idempotencyKey,
      // An inherited context would short-circuit admission and reuse a parent
      // receipt, so this run must present none.
      env: { ...process.env, PAPERCUSP_ADMISSION_CONTEXT: '' },
      executionApi: testExecutionApi(options.deps),
      settle: classifyGovernedTestProcessOutcome,
    },
    (context: AdmissionContext, governedEnv: NodeJS.ProcessEnv) =>
      new Promise((resolveRun) => {
        receiptId = context.receiptId;
        const sampler = createGovernedProcessDemandSampler(PLANNED, { intervalMs: 20 });
        const stdout: string[] = [];
        const stderr: string[] = [];
        const child = spawn(process.execPath, ['-e', options.script], {
          env: governedEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (chunk) => stdout.push(String(chunk)));
        child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
        sampler.attach(child.pid);
        child.on('close', (code, signal) => {
          exitCode = code;
          measured = sampler.stop({ diskBytes: 0 }) as ResourceDemand;
          resolveRun({
            code,
            signal,
            stdout: stdout.join(''),
            stderr: stderr.join(''),
            actualDemand: measured,
          });
        });
      }),
  );

  if (!measured) throw new Error('sampler produced no settled demand');
  // A governed run that reached settlement without a receipt id would make every
  // assertion below query nothing and pass, so this is a failure, not a default.
  if (!receiptId) throw new Error('governed run produced no durable receipt id');
  return { receiptId, measured, exitCode };
}

async function receiptRecord(receiptId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.sql<Array<{ record: Record<string, unknown> }>>`
    SELECT record
      FROM harness_shared.resource_governor_admissions
     WHERE workspace_id = ${WORKSPACE_ID}
       AND receipt_id = ${receiptId}`;
  return rows[0]?.record;
}

describe('P-007 measured actual-demand release', () => {
  it('writes the sampler-MEASURED peak into the durable receipt, not the planned reservation', async () => {
    const deps = governedDeps();
    const run = await runGovernedChild({
      idempotencyKey: 'measured-release',
      script: trustworthyChild(600),
      deps,
    });

    expect(run.exitCode).toBe(0);

    // 1. The sampler really measured the resident child, rather than settling
    //    to the planned reservation through its `?? planned` fallback.
    const measuredMemory = run.measured.memoryBytes ?? 0;
    expect(measuredMemory).toBeGreaterThan(MEASURED_FLOOR_BYTES);
    expect(measuredMemory).not.toBe(PLANNED_MEMORY_BYTES);

    // 2. That measurement survived settle -> finish -> release into Postgres.
    //    This is the assertion the two existing suites structurally cannot
    //    make: P-006 has no database, and queue.integration has no sampler.
    const record = await receiptRecord(run.receiptId);
    expect(record).toMatchObject({
      state: 'completed',
      actualDemand: { memoryBytes: measuredMemory },
      // `actualDemandReported` is decision EVIDENCE, not a top-level column
      // (queue.ts `releaseClaim` passes it through `nextDecision`). Asserting it
      // at the root silently succeeds against `undefined` on the cancel path,
      // so the path is pinned here deliberately.
      decision: { reason: 'resources-released', evidence: { actualDemandReported: true } },
    });

    // 3. And the persisted value is the MEASUREMENT, not the reservation. A
    //    receipt carrying the planned number looks identical to a correct one,
    //    which is exactly why this is asserted separately rather than inferred
    //    from `actualDemandReported`.
    const persisted = (record as { actualDemand?: ResourceDemand }).actualDemand;
    expect(persisted?.memoryBytes).toBeGreaterThan(MEASURED_FLOOR_BYTES);
    expect(persisted?.memoryBytes).not.toBe(PLANNED_MEMORY_BYTES);

    // The reservation is still what was ADMITTED — the receipt records both, so
    // a reader can see the gap the governor is meant to learn from.
    expect((record as { demand?: ResourceDemand }).demand).toMatchObject({
      memoryBytes: PLANNED_MEMORY_BYTES,
    });

    // The receipt is a ledger row, not a work-item: the whole
    // admit -> lease -> run -> release chain allocated nothing in work_items.
    expect(run.receiptId).toMatch(/^RG-/);
    expect(await workItemRowCount(db.sql, WORKSPACE_ID)).toBe(0);
  }, 60_000);

  it('discards a measurement from an untrustworthy exit instead of teaching the governor a false demand', async () => {
    const deps = governedDeps();
    const run = await runGovernedChild({
      idempotencyKey: 'untrustworthy-release',
      script: untrustworthyChild(400),
      deps,
    });

    expect(run.exitCode).toBe(1);

    // The run DID produce a real measurement — this is not a case of nothing to
    // record. The child was resident and the sampler saw it.
    expect(run.measured.memoryBytes ?? 0).toBeGreaterThan(MEASURED_FLOOR_BYTES);

    // A crashed worker produced no trustworthy verdict, so the receipt must be
    // cancelled and must carry NO actual demand. Persisting the measurement
    // here would be a false green with a number attached: the governor would
    // learn a real cost for a run whose verdict never existed.
    const record = await receiptRecord(run.receiptId);
    expect(record).toMatchObject({ state: 'cancelled' });
    expect(record).not.toHaveProperty('actualDemand');
    // Same real path as the release case, so this cannot pass vacuously against
    // a top-level field that never exists on either path.
    const evidence = (record as { decision?: { evidence?: Record<string, unknown> } }).decision?.evidence;
    expect(evidence?.actualDemandReported).not.toBe(true);
  }, 60_000);
});
