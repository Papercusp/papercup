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
  runCloudResourceObligationSweepOnce,
  CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS,
  type CloudResourceObligationRow,
  type CloudResourceObligationCaptureDep,
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

// ---------------------------------------------------------------------------------
// runCloudResourceObligationSweepOnce — the whole tick body, DBOS-free.
// ---------------------------------------------------------------------------------

function toDbRow(row: CloudResourceObligationRow): Record<string, unknown> {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    provider: row.provider,
    resource_kind: row.resourceKind,
    resource_id: row.resourceId,
    project_id: row.projectId,
    purpose: row.purpose,
    created_by_owner_id: row.createdByOwnerId,
    source_work_item_id: row.sourceWorkItemId,
    created_at: new Date(row.createdAtMs).toISOString(),
    grace_ms: row.graceMs,
    teardown_owed: row.teardownOwed,
    closed_at: row.closedAtMs === null ? null : new Date(row.closedAtMs).toISOString(),
    closed_reason: row.closedReason,
    last_escalated_at: row.lastEscalatedAtMs === null ? null : new Date(row.lastEscalatedAtMs).toISOString(),
    escalation_work_item_id: row.escalationWorkItemId,
    updated_at: new Date(row.updatedAtMs).toISOString(),
  };
}

function makeSweepFakeSql(openRows: CloudResourceObligationRow[]) {
  const markCalls: Array<{ id: number; workItemId: string }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('SELECT * FROM harness_shared.cloud_resource_obligations')) {
      return Promise.resolve(openRows.map(toDbRow));
    }
    if (text.includes('SET last_escalated_at')) {
      // Template layout: UPDATE ... SET last_escalated_at = now(), escalation_work_item_id =
      // ${workItemId} ... WHERE id = ${id} — id is the LAST interpolated value.
      markCalls.push({ id: Number(values[values.length - 1]), workItemId: String(values[0]) });
      return Promise.resolve([]);
    }
    throw new Error(`unexpected query in sweep fake sql: ${text}`);
  }) as unknown as postgres.Sql;
  return { sql, markCalls };
}

describe('runCloudResourceObligationSweepOnce', () => {
  it('escalates exactly the grace-eligible rows and marks each escalated with the returned work-item id', async () => {
    const fresh = makeRow({ id: 1, resourceId: 'fresh-still-inside-grace', createdAtMs: 900_000 });
    const stale = makeRow({ id: 2, resourceId: 'stale-past-grace', createdAtMs: 0 });
    const evaluatedAtMs = CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS;
    const { sql, markCalls } = makeSweepFakeSql([fresh, stale]);
    const capturedTitles: string[] = [];
    const capturedWatchdogKeys: string[] = [];
    const capture: CloudResourceObligationCaptureDep = async (input) => {
      capturedTitles.push(input.title);
      capturedWatchdogKeys.push(input.watchdogKey);
      return { ok: true, created: true, issue: { id: 'EI-fake-escalation' } };
    };
    const result = await runCloudResourceObligationSweepOnce(sql, { capture }, { evaluatedAtMs });
    expect(result).toEqual({ candidates: 1, escalated: 1, errors: [] });
    expect(capturedTitles).toHaveLength(1);
    expect(capturedTitles[0]).toContain('stale-past-grace');
    expect(capturedWatchdogKeys[0]).toBe('cloud-resource-obligation:gcp:nat:stale-past-grace');
    expect(markCalls).toEqual([{ id: 2, workItemId: 'EI-fake-escalation' }]);
  });

  it('files nothing when every open obligation is still inside its grace period', async () => {
    const fresh = makeRow({ id: 1, resourceId: 'fresh', createdAtMs: 900_000 });
    const { sql, markCalls } = makeSweepFakeSql([fresh]);
    const capture: CloudResourceObligationCaptureDep = async () => {
      throw new Error('capture must not be called for a fresh obligation');
    };
    const result = await runCloudResourceObligationSweepOnce(
      sql,
      { capture },
      { evaluatedAtMs: 900_000 + 1000 },
    );
    expect(result).toEqual({ candidates: 0, escalated: 0, errors: [] });
    expect(markCalls).toEqual([]);
  });

  it('records a per-candidate capture failure without aborting the rest of the sweep', async () => {
    const bad = makeRow({ id: 1, resourceId: 'bad', createdAtMs: 0 });
    const good = makeRow({ id: 2, resourceId: 'good', createdAtMs: 0 });
    const evaluatedAtMs = CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS;
    const { sql, markCalls } = makeSweepFakeSql([bad, good]);
    const capture: CloudResourceObligationCaptureDep = async (input) => {
      if (input.watchdogKey.includes('bad')) throw new Error('capture backend unavailable');
      return { ok: true, created: true, issue: { id: 'EI-good' } };
    };
    const result = await runCloudResourceObligationSweepOnce(sql, { capture }, { evaluatedAtMs });
    expect(result.candidates).toBe(2);
    expect(result.escalated).toBe(1);
    expect(result.errors).toEqual([{ id: 1, error: 'capture backend unavailable' }]);
    expect(markCalls).toEqual([{ id: 2, workItemId: 'EI-good' }]);
  });

  it('does not mark escalated when capture coalesced without returning an issue id', async () => {
    const row = makeRow({ id: 1, resourceId: 'coalesced', createdAtMs: 0 });
    const evaluatedAtMs = CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS;
    const { sql, markCalls } = makeSweepFakeSql([row]);
    const capture: CloudResourceObligationCaptureDep = async () => ({ ok: true, created: false });
    const result = await runCloudResourceObligationSweepOnce(sql, { capture }, { evaluatedAtMs });
    expect(result).toEqual({ candidates: 1, escalated: 0, errors: [] });
    expect(markCalls).toEqual([]);
  });
});
