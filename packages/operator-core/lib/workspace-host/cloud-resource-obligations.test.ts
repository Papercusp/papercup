/**
 * Unit tests for the cloud-resource-obligations ledger (EI-21915296593490861).
 *
 * `selectCloudResourceObligationsToEscalate` is pure and tested directly with
 * synthetic rows. The DB-touching writers are tested against a fake postgres.js
 * tagged-template dispatcher (mirrors db-pgss-orphan-stats-reclaim.test.ts) rather
 * than testcontainers, since the logic under test is the SQL shape and idempotency
 * contract, not real Postgres behavior.
 */
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import {
  selectCloudResourceObligationsToEscalate,
  recordCloudResourceObligation,
  closeCloudResourceObligation,
  markCloudResourceObligationEscalated,
  CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS,
  type CloudResourceObligationRow,
} from './cloud-resource-obligations';

function makeRow(overrides: Partial<CloudResourceObligationRow> = {}): CloudResourceObligationRow {
  return {
    id: 1,
    workspaceId: 'papercusp-workspace',
    provider: 'gcp',
    resourceKind: 'nat',
    resourceId: 'pc-p046-rel-nat',
    projectId: 'active-alcove-504205-q3',
    purpose: 'p046-release-cut',
    createdByOwnerId: 'su-example',
    sourceWorkItemId: 'WI-40474',
    createdAtMs: 0,
    graceMs: CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS,
    teardownOwed: true,
    closedAtMs: null,
    closedReason: '',
    lastEscalatedAtMs: null,
    escalationWorkItemId: '',
    updatedAtMs: 0,
    ...overrides,
  };
}

describe('selectCloudResourceObligationsToEscalate', () => {
  it('does not escalate a fresh obligation still inside its grace period', () => {
    const row = makeRow({ createdAtMs: 1_000_000 });
    const evaluatedAtMs = 1_000_000 + CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS - 1;
    expect(selectCloudResourceObligationsToEscalate([row], evaluatedAtMs)).toEqual([]);
  });

  it('escalates an obligation exactly at its grace boundary', () => {
    const row = makeRow({ createdAtMs: 1_000_000 });
    const evaluatedAtMs = 1_000_000 + CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS;
    const out = selectCloudResourceObligationsToEscalate([row], evaluatedAtMs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 1,
      resourceKind: 'nat',
      resourceId: 'pc-p046-rel-nat',
      hadPriorEscalation: false,
      ageMs: CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS,
    });
  });

  it('skips a row already closed, even if past grace (caller should have filtered it, but the guard re-asserts)', () => {
    const row = makeRow({ createdAtMs: 0, closedAtMs: 500 });
    expect(selectCloudResourceObligationsToEscalate([row], 1_000_000_000)).toEqual([]);
  });

  it('skips a row whose teardown is no longer owed', () => {
    const row = makeRow({ createdAtMs: 0, teardownOwed: false });
    expect(selectCloudResourceObligationsToEscalate([row], 1_000_000_000)).toEqual([]);
  });

  it('does NOT re-escalate within the cooldown window after a prior escalation', () => {
    const row = makeRow({ createdAtMs: 0, lastEscalatedAtMs: 1_000_000 });
    const cooldownMs = 12 * 60 * 60 * 1000;
    const evaluatedAtMs = 1_000_000 + cooldownMs - 1;
    expect(selectCloudResourceObligationsToEscalate([row], evaluatedAtMs, cooldownMs)).toEqual([]);
  });

  it('re-nudges once the cooldown has elapsed, flagging hadPriorEscalation', () => {
    const row = makeRow({
      createdAtMs: 0,
      lastEscalatedAtMs: 1_000_000,
      escalationWorkItemId: 'EI-old-escalation',
    });
    const cooldownMs = 12 * 60 * 60 * 1000;
    const evaluatedAtMs = 1_000_000 + cooldownMs;
    const out = selectCloudResourceObligationsToEscalate([row], evaluatedAtMs, cooldownMs);
    expect(out).toHaveLength(1);
    expect(out[0]!.hadPriorEscalation).toBe(true);
    expect(out[0]!.priorEscalationWorkItemId).toBe('EI-old-escalation');
  });

  it('orders multiple candidates oldest-first (the longest-standing obligation is most urgent)', () => {
    const newer = makeRow({ id: 2, resourceId: 'newer', createdAtMs: 500_000 });
    const older = makeRow({ id: 1, resourceId: 'older', createdAtMs: 0 });
    const evaluatedAtMs = 500_000 + CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS;
    const out = selectCloudResourceObligationsToEscalate([newer, older], evaluatedAtMs);
    expect(out.map((c) => c.resourceId)).toEqual(['older', 'newer']);
  });

  it('rejects a non-finite evaluatedAtMs rather than silently miscomputing age', () => {
    expect(() => selectCloudResourceObligationsToEscalate([makeRow()], Number.NaN)).toThrow(/finite/);
  });
});

// ---------------------------------------------------------------------------------
// DB-writer contract tests against a fake postgres.js tagged-template dispatcher.
// ---------------------------------------------------------------------------------

interface FakeCall {
  text: string;
  values: unknown[];
}

function makeFakeSql(opts: {
  insertReturnsRow?: boolean;
  existingIdOnConflict?: number;
  updateAffected?: boolean;
} = {}) {
  const calls: FakeCall[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('INSERT INTO harness_shared.cloud_resource_obligations')) {
      if (opts.insertReturnsRow ?? true) return Promise.resolve([{ id: 42, inserted: true }]);
      return Promise.resolve([]); // ON CONFLICT DO NOTHING — no row
    }
    if (text.includes('SELECT id FROM harness_shared.cloud_resource_obligations')) {
      return Promise.resolve(opts.existingIdOnConflict !== undefined ? [{ id: opts.existingIdOnConflict }] : []);
    }
    if (text.includes('UPDATE harness_shared.cloud_resource_obligations') && text.includes('SET closed_at')) {
      return Promise.resolve((opts.updateAffected ?? true) ? [{ id: 42 }] : []);
    }
    if (text.includes('UPDATE harness_shared.cloud_resource_obligations') && text.includes('last_escalated_at')) {
      return Promise.resolve([]);
    }
    throw new Error(`unexpected query in fake sql: ${text}`);
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

describe('recordCloudResourceObligation', () => {
  it('inserts a fresh obligation and reports created:true', async () => {
    const { sql } = makeFakeSql({ insertReturnsRow: true });
    const r = await recordCloudResourceObligation(sql, {
      workspaceId: 'papercusp-workspace',
      provider: 'gcp',
      resourceKind: 'nat',
      resourceId: 'pc-p046-rel-nat',
      purpose: 'p046-release-cut',
    });
    expect(r).toEqual({ id: 42, created: true });
  });

  it('is idempotent: a duplicate call finds the existing row and reports created:false', async () => {
    const { sql } = makeFakeSql({ insertReturnsRow: false, existingIdOnConflict: 7 });
    const r = await recordCloudResourceObligation(sql, {
      workspaceId: 'papercusp-workspace',
      provider: 'gcp',
      resourceKind: 'nat',
      resourceId: 'pc-p046-rel-nat',
    });
    expect(r).toEqual({ id: 7, created: false });
  });

  it('rejects an empty resourceId before ever touching sql', async () => {
    const { sql, calls } = makeFakeSql();
    await expect(
      recordCloudResourceObligation(sql, {
        workspaceId: 'papercusp-workspace',
        provider: 'gcp',
        resourceKind: 'nat',
        resourceId: '   ',
      }),
    ).rejects.toThrow(/resourceId/);
    expect(calls).toHaveLength(0);
  });
});

describe('closeCloudResourceObligation', () => {
  it('reports closed:true when a row was actually updated', async () => {
    const { sql } = makeFakeSql({ updateAffected: true });
    const r = await closeCloudResourceObligation(sql, {
      workspaceId: 'papercusp-workspace',
      provider: 'gcp',
      resourceKind: 'nat',
      resourceId: 'pc-p046-rel-nat',
      reason: 'torn down via gcloud compute routers nats delete',
    });
    expect(r).toEqual({ closed: true });
  });

  it('reports closed:false (no-op) when already closed', async () => {
    const { sql } = makeFakeSql({ updateAffected: false });
    const r = await closeCloudResourceObligation(sql, {
      workspaceId: 'papercusp-workspace',
      provider: 'gcp',
      resourceKind: 'nat',
      resourceId: 'pc-p046-rel-nat',
      reason: 'already closed',
    });
    expect(r).toEqual({ closed: false });
  });

  it('requires a non-empty reason', async () => {
    const { sql } = makeFakeSql();
    await expect(
      closeCloudResourceObligation(sql, {
        workspaceId: 'papercusp-workspace',
        provider: 'gcp',
        resourceKind: 'nat',
        resourceId: 'pc-p046-rel-nat',
        reason: '',
      }),
    ).rejects.toThrow(/reason/);
  });
});

describe('markCloudResourceObligationEscalated', () => {
  it('requires a non-empty work item id', async () => {
    const { sql } = makeFakeSql();
    await expect(markCloudResourceObligationEscalated(sql, 1, '')).rejects.toThrow(/workItemId/);
  });
});
