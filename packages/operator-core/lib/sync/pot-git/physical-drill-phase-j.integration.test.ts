/**
 * P-521 F4 Phase J against real Postgres: two databases stand in for the two
 * hosts, the real Phase J fault trigger is the outage, and the production
 * read-merge (`mergeAdmittedLogsIncremental` + the PG merge-cursor store) is the
 * target apply. The observations this produces go through the same verifier the
 * physical run uses. The physical owner restart is modelled by its durable seam:
 * a fresh cursor seeded from PG.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  createMergeCursor, mergeAdmittedLogsIncremental, persistCursor, seedCursorFromPg,
  type AdmittedLog, type MergeCursor,
} from '../hyperbee/read-merge';
import { createPgMergeCursorStore } from '../hyperbee/pg-merge-cursor-store';
import type { OpEnvelope } from '../hyperbee/op-envelope-types';
import type { PeerLogOp } from '../hyperbee/peer-log';
import { PHASE_A_POT_HOME } from './physical-drill-phase-a';
import {
  PHASE_J_INPUT_SCHEMA, PHASE_J_MIN_ATTEMPTS, PHASE_J_WORKSPACE_ID,
  installPhysicalPhaseJFault, observePhysicalPhaseJ, phaseJLag, phaseJWriteSummary, phaseJWriteTitle,
  removePhysicalPhaseJFault, sweepPhysicalPhaseJFaults, validatePhysicalPhaseJ,
  type PhysicalPhaseJInput, type PhysicalPhaseJWrite,
} from './physical-drill-phase-j';

const RUN = 'p505-physical-20260930T020000Z-7';
const TOWER = Buffer.alloc(32, 7).toString('base64');
const VM = Buffer.alloc(32, 9).toString('base64');
const LOG = 'cd'.repeat(32);
const IDS: Record<PhysicalPhaseJWrite, string> = { A: 'EI-501', B: 'EI-502' };

function migrationPath(name: string): string {
  const path = fileURLToPath(new URL(`../../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url));
  return existsSync(path) ? path : `${path}.DRAFT`;
}

const WORK_ITEMS = `CREATE TABLE harness_shared.work_items (
  workspace_id text, harness_slug text NOT NULL, feature_id text NOT NULL, item_kind text NOT NULL,
  title text NOT NULL, summary text, author_pubkey text, origin text, PRIMARY KEY (harness_slug, feature_id))`;

describe('P-521 Phase J: real fault, production read-merge, durable cursor, exact replay', () => {
  let vmDb: FreshPgDb;
  let towerDb: FreshPgDb;
  let vm: postgres.Sql;
  let tower: postgres.Sql;
  beforeAll(async () => {
    [vmDb, towerDb] = await Promise.all([createFreshPgDb('phase-j-vm'), createFreshPgDb('phase-j-tower')]);
    vm = vmDb.sql;
    tower = towerDb.sql;
    for (const name of [
      '493-substrate-merge-cursor.sql', '685-substrate-merge-cursor-apply-binding.sql',
      '854-substrate-merge-cursor-peer-lifecycle.sql', '1122-substrate-merge-cursor-apply-failure.sql', '1206-substrate-merge-cursor-snapshot-apply-mark.sql',
    ]) await applyMigrationForTest(vm, migrationPath(name));
    await tower.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    await vm.unsafe(WORK_ITEMS);
    await tower.unsafe(WORK_ITEMS);
  }, 180_000);
  afterAll(async () => { await Promise.all([vmDb?.cleanup(), towerDb?.cleanup()]); });
  // A test that fails between install and remove leaves its outage trigger on the VM, and
  // install refuses over ANY existing p521 outage trigger, so the next test would fail for
  // that reason instead of its own. Sweep after every test so each starts fault-free.
  afterEach(async () => { if (vm) await sweepPhysicalPhaseJFaults({ sql: vm }); });

  it('holds the cursor at the missing write across the retired budget and a restart, then replays it exactly', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const startedAt = Date.now() - 1_000;
    let skew = 0; // the physical hold is >= 60s; the observers read a clock that has moved on.
    const now = () => Date.now() + skew;
    const baselineTower = await observePhysicalPhaseJ({ hostId: 'tower', step: 'baseline', runId: RUN }, { sql: tower, now });
    const baselineVm = await observePhysicalPhaseJ({ hostId: 'vm', step: 'baseline', runId: RUN }, { sql: vm, now });
    const install = await installPhysicalPhaseJFault({ runId: RUN }, { sql: vm, now });
    await expect(installPhysicalPhaseJFault({ runId: RUN }, { sql: vm })).rejects.toThrow(/refuses to install over existing/);

    // The tower authors A then B; its log carries them to the VM in that order.
    const ops: PeerLogOp[] = [];
    for (const write of ['A', 'B'] as const) {
      const value = {
        workspace_id: PHASE_J_WORKSPACE_ID, harness_slug: PHASE_A_POT_HOME, feature_id: IDS[write], item_kind: 'task',
        title: phaseJWriteTitle(RUN, write), summary: phaseJWriteSummary(RUN, write),
      };
      await tower`INSERT INTO harness_shared.work_items ${tower({ ...value, author_pubkey: TOWER, origin: 'local' })}`;
      ops.push({ type: 'put', table: 'engineer-issues', hbKey: `${PHASE_A_POT_HOME}/${IDS[write]}`, value, ts: ops.length + 1, schema_version: 1, author_pubkey: TOWER });
    }
    const authored = await observePhysicalPhaseJ({ hostId: 'tower', step: 'authored', runId: RUN }, { sql: tower, now });
    const source: AdmittedLog = { keyHex: LOG, length: ops.length, get: async (i) => ops[i] ?? null };
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      const v = op.value as Record<string, string>;
      await vm`INSERT INTO harness_shared.work_items ${vm({ ...v, author_pubkey: TOWER, origin: 'remote' })}
        ON CONFLICT (harness_slug, feature_id) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary`;
      return true;
    };
    const store = createPgMergeCursorStore(PHASE_J_WORKSPACE_ID, PHASE_A_POT_HOME, () => vm);
    const persist = (c: MergeCursor) => persistCursor(c.positions, store, PHASE_A_POT_HOME, c.applyFailures ?? new Map());
    const pass = async (c: MergeCursor) => mergeAdmittedLogsIncremental([source], c, { applyImpl: apply, getTimeoutMs: 0, onCursorAdvance: () => persist(c) });

    // Outage: more passes than the retired budget; the durable cursor never moves.
    const cursor = createMergeCursor();
    const held = [];
    for (let i = 0; i < PHASE_J_MIN_ATTEMPTS + 2; i++) {
      expect((await pass(cursor)).caughtUp).toBe(false);
      expect((await store.load(PHASE_A_POT_HOME)).get(LOG)).toBe(0);
    }
    const early = await observePhysicalPhaseJ({ hostId: 'vm', step: 'held', runId: RUN, featureIds: [IDS.A] }, { sql: vm, now });
    expect(phaseJLag(early, { featureIdA: IDS.A })).toEqual([expect.stringMatching(/^held \d+ms < 60000ms$/)]);
    held.push(early);
    skew = 61_000;
    const late = await observePhysicalPhaseJ({ hostId: 'vm', step: 'held', runId: RUN, featureIds: [IDS.A] }, { sql: vm, now });
    expect(phaseJLag(late, { featureIdA: IDS.A })).toEqual([]);
    held.push(late);

    // Restart: a fresh consumer seeded from PG still holds, and still fails under the fault.
    skew = 62_000;
    const restarted = createMergeCursor();
    await seedCursorFromPg(restarted, store, PHASE_A_POT_HOME);
    expect((await pass(restarted)).caughtUp).toBe(false);
    const heldAfterRestart = await observePhysicalPhaseJ({ hostId: 'vm', step: 'held-after-restart', runId: RUN, featureIds: [IDS.A] }, { sql: vm, now });
    expect(phaseJLag(heldAfterRestart, { featureIdA: IDS.A })).toEqual([]);

    skew = 63_000;
    const remove = await removePhysicalPhaseJFault({ runId: RUN }, { sql: vm, now });
    skew = 64_000;
    expect(await pass(restarted)).toMatchObject({ applied: 2, caughtUp: true });
    const replayed = await observePhysicalPhaseJ({ hostId: 'vm', step: 'replayed', runId: RUN, featureIds: [IDS.A] }, { sql: vm, now });
    expect(phaseJLag(replayed, { featureIdA: IDS.A, logKeyHex: LOG, heldPosition: 0 })).toEqual([]);

    const input: PhysicalPhaseJInput = {
      schemaVersion: PHASE_J_INPUT_SCHEMA, runId: RUN,
      window: { startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(now() + 1_000).toISOString() },
      identities: { towerDeviceKey: TOWER, vmDeviceKey: VM },
      baseline: { tower: baselineTower, vm: baselineVm }, fault: { install, remove }, authored, held,
      vmOwner: { before: { pid: 11, build: 'version:0.0.25', launcher: 'serve' }, after: { pid: 12, build: 'version:0.0.25', launcher: 'serve' } },
      heldAfterRestart, replayed,
    };
    const verdict = validatePhysicalPhaseJ(input);
    expect(verdict.errors).toEqual([]);
    expect(verdict.result?.identities).toMatchObject({ logKeyHex: LOG, heldPosition: 0, featureIds: IDS });
    expect(verdict.result!.identities.attemptsBeforeRestart).toBeGreaterThanOrEqual(PHASE_J_MIN_ATTEMPTS);
    expect(held[1]!.cursors[0]!.applyFailure).toMatchObject({ kind: 'retryable', errorCode: '57P03' });
  });

  it('sweeps a stranded fault from a crashed run', async () => {
    await installPhysicalPhaseJFault({ runId: 'p505-physical-crashed-run-1' }, { sql: vm });
    const swept = await sweepPhysicalPhaseJFaults({ sql: vm });
    expect(swept.removed).toHaveLength(1);
    expect(swept.remaining).toEqual([]);
  });
});
