import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import type {
  CanonicalParticipantReceiptAuthority,
  FrozenPilotCandidate,
  MaterializePilotCohortInput,
  PilotMaterializationDependencies,
  PilotMaterializationRow,
  PilotMaterializationScope,
} from './pilot-materialization-core';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { PILOT_MATERIALIZATION_KEYS, createPgPilotMaterializationStore, materializePilotCohort } =
  await import('./pilot-materialization-core');

const WORKSPACE = 'pilot-materialization-pg-test';
const HARNESS = 'pilot-materialization';
const DEPENDENCY_WORKSPACE = 'default';
const SHA = 'a'.repeat(40);
const TAKEN_AT = '2026-08-27T05:00:00.000Z';
const IDS = Array.from({ length: 21 }, (_, index) => 'WI-' + String(index + 1).padStart(3, '0'));
const SCOPE: PilotMaterializationScope = {
  workspaceId: WORKSPACE,
  harnessSlug: HARNESS,
  dependencyWorkspaceId: DEPENDENCY_WORKSPACE,
};

const SCHEMA_DDL = `
  CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    status text NOT NULL,
    kind text,
    updated_ts bigint NOT NULL,
    taken_by text,
    taken_at timestamptz,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
  );
  CREATE TABLE harness_shared.work_item_deps (
    workspace_id text NOT NULL,
    dep_type text NOT NULL,
    blocked_ref text NOT NULL,
    blocker_kind text NOT NULL,
    blocker_ref text NOT NULL
  );
  CREATE TABLE harness_shared.harness_features_consolidated (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    status text NOT NULL
  );
  CREATE TABLE harness_shared.engineer_issues (
    workspace_id text NOT NULL,
    issue_id text NOT NULL,
    state text NOT NULL
  );
  CREATE TABLE harness_shared.audit_log (
    id uuid PRIMARY KEY,
    ts bigint NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    subject text NOT NULL,
    details jsonb NOT NULL,
    workspace_id text NOT NULL
  );
`;

const receiptAuthority: CanonicalParticipantReceiptAuthority = {
  validate: (candidates) => {
    const errors: string[] = [];
    const participantsByItem: Record<string, unknown[]> = {};
    for (const candidate of candidates) {
      const payload = candidate.payload as Record<string, unknown>;
      const bindings = payload?.pilotBindingReceipts;
      const dispatches = payload?.pilotDispatchReceipts;
      if (!Array.isArray(bindings) || bindings.length !== 1) {
        errors.push(candidate.id + ': binding receipt missing');
      }
      if (!Array.isArray(dispatches) || dispatches.length !== 1) {
        errors.push(candidate.id + ': dispatch receipt missing');
      }
      participantsByItem[candidate.id] = [
        {
          ownerId: candidate.expectedOwnerId,
          claimVersion: candidate.expectedClaimVersion,
          bindingReceiptId: (bindings as Array<{ receiptId?: string }> | undefined)?.[0]?.receiptId,
          dispatchReceiptId: (dispatches as Array<{ receiptId?: string }> | undefined)?.[0]?.receiptId,
        },
      ];
    }
    return { ok: errors.length === 0, errors, participantsByItem };
  },
};

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('pilot-materialization');
  h.sql = db.sql;
  await db.sql.unsafe(SCHEMA_DDL);
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql.unsafe(
    'TRUNCATE harness_shared.audit_log, harness_shared.work_item_deps, ' +
      'harness_shared.harness_features_consolidated, harness_shared.engineer_issues, ' +
      'harness_shared.work_items',
  );
  const rows = IDS.map((id, index) => ({
    feature_id: id,
    updated_ts: 100 + index,
    taken_by: 'su-' + String(index + 1),
    payload: {
      untouched: 'row-' + index,
      pilotBindingReceipts: [{ receiptId: 'binding-' + index }],
      pilotDispatchReceipts: [{ receiptId: 'dispatch-' + index }],
    },
  }));
  await db.sql.unsafe(
    'INSERT INTO harness_shared.work_items ' +
      '(workspace_id, harness_slug, feature_id, status, kind, updated_ts, taken_by, taken_at, payload) ' +
      "SELECT $1, $2, r.feature_id, 'open', 'change', r.updated_ts, r.taken_by, $3::timestamptz, r.payload " +
      'FROM jsonb_to_recordset($4::text::jsonb) AS r(feature_id text, updated_ts bigint, taken_by text, payload jsonb)',
    [WORKSPACE, HARNESS, TAKEN_AT, JSON.stringify(rows)],
  );
  await db.sql.unsafe(
    'INSERT INTO harness_shared.work_items ' +
      '(workspace_id, harness_slug, feature_id, status, kind, updated_ts, payload) ' +
      "VALUES ($1, $2, 'WI-PROBE', 'passed', 'task', 500, $3::text::jsonb)",
    [
      WORKSPACE,
      HARNESS,
      JSON.stringify({
        pilotArmBGateProbe: {
          status: 'passed',
          judgementPersisted: true,
          testedSha: SHA,
          deployedSha: SHA,
        },
      }),
    ],
  );
});

function fixtureInput(rows: readonly PilotMaterializationRow[]): MaterializePilotCohortInput {
  const candidates: FrozenPilotCandidate[] = rows.map((row, index) => ({
    id: row.id,
    tier: 'substantive',
    stratum: index % 2 ? 'operator-core' : 'operator-api',
    expectedUpdatedTs: row.updatedTs,
    expectedAssignee: row.assignee!,
    expectedTakenAt: row.takenAt!,
  }));
  return {
    workspaceId: WORKSPACE,
    harnessSlug: HARNESS,
    dependencyWorkspaceId: DEPENDENCY_WORKSPACE,
    actor: 'su-pg-test',
    seed: 'p-018-real-pg-seed',
    armBProbeItemId: 'WI-PROBE',
    candidates,
  };
}

function dependencies(overrides: Partial<PilotMaterializationDependencies> = {}): PilotMaterializationDependencies {
  return {
    store: createPgPilotMaterializationStore(),
    receiptAuthority,
    loadCurrentReleasePin: async () => ({
      deployedSha: SHA,
      greenPinSha: SHA,
      capturedAtMs: 1_500,
    }),
    now: () => 2_000,
    ...overrides,
  };
}

async function currentInput(): Promise<MaterializePilotCohortInput> {
  const rows = await createPgPilotMaterializationStore().readRows(SCOPE, IDS);
  return fixtureInput(rows);
}

async function cohortSnapshot(): Promise<string[]> {
  const rows = (await db.sql.unsafe(
    "SELECT jsonb_build_object('feature_id', feature_id, 'status', status, 'kind', kind, " +
      "'updated_ts', updated_ts, 'taken_by', taken_by, " +
      "'taken_at', to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), " +
      "'payload', payload)::text AS snapshot " +
      'FROM harness_shared.work_items WHERE workspace_id = $1 AND harness_slug = $2 ' +
      'AND feature_id = ANY($3::text[]) ORDER BY feature_id',
    [WORKSPACE, HARNESS, IDS],
  )) as unknown as Array<{ snapshot: string }>;
  return rows.map((row) => row.snapshot);
}

async function auditRows(): Promise<Array<{ action: string; details: Record<string, unknown> }>> {
  return (await db.sql.unsafe(
    'SELECT action, details FROM harness_shared.audit_log WHERE workspace_id = $1 ORDER BY ts, action',
    [WORKSPACE],
  )) as unknown as Array<{ action: string; details: Record<string, unknown> }>;
}

describe('pilot materialization production Postgres adapter', () => {
  it('atomically materializes exactly 21 rows and persists the success audit', async () => {
    const result = await materializePilotCohort(await currentInput(), dependencies());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.ids).toEqual(IDS);
    const stored = await createPgPilotMaterializationStore().readRows(SCOPE, IDS);
    expect(stored).toHaveLength(21);
    for (const row of stored) {
      for (const key of PILOT_MATERIALIZATION_KEYS) expect(row.payload).toHaveProperty(key);
      expect(row.payload.untouched).toMatch(/^row-/);
    }
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'pilot.materialize',
      details: {
        kind: 'pilot-cohort-materialized',
        receiptId: result.receipt.receiptId,
        ids: IDS,
      },
    });
  });

  it.each(['stale', 'held', 'blocked', 'prestamped'] as const)(
    'leaves all 21 rows byte-exact when one row is %s',
    async (variant) => {
      if (variant === 'held') {
        await db.sql.unsafe(
          'UPDATE harness_shared.work_items SET payload = payload || \'{"_claimHold":true}\'::jsonb ' +
            'WHERE workspace_id = $1 AND harness_slug = $2 AND feature_id = $3',
          [WORKSPACE, HARNESS, IDS[7]],
        );
      } else if (variant === 'prestamped') {
        await db.sql.unsafe(
          'UPDATE harness_shared.work_items SET payload = payload || \'{"pilotArm":"B"}\'::jsonb ' +
            'WHERE workspace_id = $1 AND harness_slug = $2 AND feature_id = $3',
          [WORKSPACE, HARNESS, IDS[7]],
        );
      } else if (variant === 'blocked') {
        await db.sql.unsafe(
          'INSERT INTO harness_shared.harness_features_consolidated ' +
            '(workspace_id, harness_slug, feature_id, status) VALUES ($1,$2,$3,$4)',
          [WORKSPACE, HARNESS, 'WI-BLOCKER', 'open'],
        );
        await db.sql.unsafe(
          'INSERT INTO harness_shared.work_item_deps ' +
            '(workspace_id, dep_type, blocked_ref, blocker_kind, blocker_ref) ' +
            "VALUES ($1, 'blocks', $2, 'feature', $3)",
          [DEPENDENCY_WORKSPACE, IDS[7], HARNESS + '#WI-BLOCKER'],
        );
      }

      const input = await currentInput();
      const attempted =
        variant === 'stale'
          ? {
              ...input,
              candidates: input.candidates.map((candidate, index) =>
                index === 7 ? { ...candidate, expectedUpdatedTs: candidate.expectedUpdatedTs - 1 } : candidate,
              ),
            }
          : input;
      const before = await cohortSnapshot();
      const result = await materializePilotCohort(attempted, dependencies());

      expect(result.ok).toBe(false);
      expect(await cohortSnapshot()).toEqual(before);
      const stored = await createPgPilotMaterializationStore().readRows(SCOPE, IDS);
      expect(
        stored.filter((row) => PILOT_MATERIALIZATION_KEYS.some((key) => Object.hasOwn(row.payload, key))),
      ).toHaveLength(variant === 'prestamped' ? 1 : 0);
      if (!result.ok) {
        expect(result.receipt.touchedIds).toEqual([]);
        expect(result.receipt.rollbackVerified).toBe(true);
        expect(result.receipt.auditPersisted).toBe(true);
      }
      expect((await auditRows()).map((row) => row.action)).toEqual(['pilot.materialize.abort']);
    },
  );

  it('permits exactly one winner across concurrent production transactions', async () => {
    const input = await currentInput();
    const [left, right] = await Promise.all([
      materializePilotCohort(input, dependencies()),
      materializePilotCohort(input, dependencies()),
    ]);

    expect([left.ok, right.ok].sort()).toEqual([false, true]);
    const stored = await createPgPilotMaterializationStore().readRows(SCOPE, IDS);
    expect(stored.filter((row) => Object.hasOwn(row.payload, 'pilotArm'))).toHaveLength(21);
    const actions = (await auditRows()).map((row) => row.action).sort();
    expect(actions).toEqual(['pilot.materialize', 'pilot.materialize.abort']);
  });

  it('rolls back all 21 rows byte-exact after a post-UPDATE failure and persists a verified abort audit', async () => {
    const before = await cohortSnapshot();
    const result = await materializePilotCohort(
      await currentInput(),
      dependencies({
        afterApply: () => {
          throw new Error('injected post-UPDATE failure');
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(await cohortSnapshot()).toEqual(before);
    if (result.ok) return;
    expect(result.receipt.reason).toContain('injected post-UPDATE failure');
    expect(result.receipt.touchedIds).toEqual(IDS);
    expect(result.receipt.preimages).toHaveLength(21);
    expect(result.receipt.observedAfterRollback).toEqual(result.receipt.preimages);
    expect(result.receipt.rollbackVerified).toBe(true);
    expect(result.receipt.rollbackMismatches).toEqual([]);
    expect(result.receipt.auditPersisted).toBe(true);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'pilot.materialize.abort',
      details: {
        kind: 'pilot-cohort-abort',
        touchedIds: IDS,
        rollbackVerified: true,
        rollbackMismatches: [],
      },
    });
    expect(audits[0].details.preimages as unknown[]).toHaveLength(21);
    expect(audits[0].details.observedAfterRollback as unknown[]).toHaveLength(21);
  });
});
