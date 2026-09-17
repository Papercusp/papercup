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
  cloudResourceObligationSourceKey,
  CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS,
  CLOUD_RESOURCE_OBLIGATION_IN_USE_SUPPRESSION_CEILING_MS,
  CLOUD_RESOURCE_OBLIGATION_DEFAULT_RECLAIM_AFTER_MS,
  describeCloudResourceDeleteAddress,
  planCloudResourceObligationReclamation,
  createCloudResourceObligationObserver,
  type CloudResourceObligationRow,
  type CloudResourceObligationCaptureDep,
  type CloudResourceCreatedEventLike,
} from './cloud-resource-obligations';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

function makeRow(overrides: Partial<CloudResourceObligationRow> = {}): CloudResourceObligationRow {
  return {
    id: 1,
    workspaceId: 'papercusp-workspace',
    provider: 'gcp',
    resourceKind: 'nat',
    resourceId: 'pc-p046-rel-nat',
    projectId: 'active-alcove-504205-q3',
    // Location (migration 1168). The default kind is `nat`, so the default row is
    // deliberately ADDRESSABLE — region + owning router + host — and a test that wants the
    // unaddressable case blanks one of them explicitly rather than relying on an omission.
    zone: '',
    region: 'us-central1',
    parentResourceId: 'pc-p046-rel-router',
    hostId: 'pc-p046-rel',
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
// IN-USE suppression: an obligation whose originating work-item is still open is not a
// leak. Regression for the measured 2026-08-31 incident — all four open obligations
// shared one still-open source (WI-40474) whose holder was live and mid-Packer-run, and
// the sweep filed four "undischarged resource" bugs against infrastructure in active use.
// ---------------------------------------------------------------------------------

describe('selectCloudResourceObligationsToEscalate — in-use suppression', () => {
  const pastGrace = CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS;
  const openKeys = (...rows: CloudResourceObligationRow[]) =>
    new Set(rows.map((r) => cloudResourceObligationSourceKey(r.workspaceId, r.sourceWorkItemId)));

  it('suppresses an obligation whose originating work-item is still open', () => {
    const row = makeRow({ createdAtMs: 0 });
    const out = selectCloudResourceObligationsToEscalate([row], pastGrace, undefined, {
      openSourceWorkItemKeys: openKeys(row),
    });
    expect(out).toEqual([]);
  });

  it('suppresses EVERY sibling obligation sharing one still-open source work-item', () => {
    // The exact measured shape: 4 resources, 1 source work-item, source still open.
    const rows = (['network', 'subnetwork', 'router', 'nat'] as const).map((kind, i) =>
      makeRow({ id: i + 1, resourceKind: kind, resourceId: `pc-p046-rel-${kind}`, createdAtMs: 0 }),
    );
    const out = selectCloudResourceObligationsToEscalate(rows, pastGrace, undefined, {
      openSourceWorkItemKeys: openKeys(rows[0]!),
    });
    expect(out).toEqual([]);
  });

  it('escalates once the source work-item reaches a terminal state', () => {
    const row = makeRow({ createdAtMs: 0 });
    // Terminal source => absent from the open set.
    const out = selectCloudResourceObligationsToEscalate([row], pastGrace, undefined, {
      openSourceWorkItemKeys: new Set<string>(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.suppressionCeilingOverridden).toBe(false);
  });

  it('escalates anyway past the ceiling, so an abandoned-open work-item cannot cloak a leak forever', () => {
    const row = makeRow({ createdAtMs: 0 });
    const evaluatedAtMs = CLOUD_RESOURCE_OBLIGATION_IN_USE_SUPPRESSION_CEILING_MS;
    const out = selectCloudResourceObligationsToEscalate([row], evaluatedAtMs, undefined, {
      openSourceWorkItemKeys: openKeys(row),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.suppressionCeilingOverridden).toBe(true);
  });

  it('suppresses nothing when the open-source set is OMITTED (fail toward escalation)', () => {
    // A caller that cannot establish source state must keep the old behaviour: filing a
    // work-item is recoverable, silently hiding a metered resource is not.
    const row = makeRow({ createdAtMs: 0 });
    expect(selectCloudResourceObligationsToEscalate([row], pastGrace)).toHaveLength(1);
  });

  it('does not let a same-named work-item in ANOTHER workspace suppress a real leak', () => {
    const row = makeRow({ createdAtMs: 0, workspaceId: 'papercusp-workspace' });
    const foreign = cloudResourceObligationSourceKey('some-other-workspace', row.sourceWorkItemId);
    const out = selectCloudResourceObligationsToEscalate([row], pastGrace, undefined, {
      openSourceWorkItemKeys: new Set([foreign]),
    });
    expect(out).toHaveLength(1);
  });

  it('never suppresses an obligation that records no source work-item at all', () => {
    const row = makeRow({ createdAtMs: 0, sourceWorkItemId: '' });
    const out = selectCloudResourceObligationsToEscalate([row], pastGrace, undefined, {
      openSourceWorkItemKeys: new Set([cloudResourceObligationSourceKey(row.workspaceId, '')]),
    });
    expect(out).toHaveLength(1);
  });

  it('rejects a negative suppression ceiling rather than silently disabling the gate', () => {
    expect(() =>
      selectCloudResourceObligationsToEscalate([makeRow()], pastGrace, undefined, {
        inUseSuppressionCeilingMs: -1,
      }),
    ).toThrow(/non-negative/);
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

function makeSweepFakeSql(
  openRows: CloudResourceObligationRow[],
  /**
   * Source work-items that are still NON-terminal, as the work_items probe would return
   * them. Defaults to EMPTY — i.e. every source work-item is already terminal — so the
   * pre-existing sweep tests keep asserting the same escalate-on-time behaviour.
   */
  openSourceWorkItems: Array<{ workspaceId: string; featureId: string }> = [],
  opts: { failSourceRead?: boolean } = {},
) {
  const markCalls: Array<{ id: number; workItemId: string }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('SELECT * FROM harness_shared.cloud_resource_obligations')) {
      return Promise.resolve(openRows.map(toDbRow));
    }
    if (text.includes('FROM harness_shared.work_items')) {
      if (opts.failSourceRead) return Promise.reject(new Error('work_items probe exploded'));
      return Promise.resolve(
        openSourceWorkItems.map((w) => ({ workspace_id: w.workspaceId, feature_id: w.featureId })),
      );
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

  it('files NOTHING for four sibling resources whose one source work-item is still open', async () => {
    // End-to-end regression for the measured incident: without the in-use gate this tick
    // filed four bugs against live infrastructure, and re-filed them every 12h.
    const rows = (['network', 'subnetwork', 'router', 'nat'] as const).map((kind, i) =>
      makeRow({ id: i + 1, resourceKind: kind, resourceId: `pc-p046-rel-${kind}`, createdAtMs: 0 }),
    );
    const { sql, markCalls } = makeSweepFakeSql(rows, [
      { workspaceId: rows[0]!.workspaceId, featureId: rows[0]!.sourceWorkItemId },
    ]);
    const capture: CloudResourceObligationCaptureDep = async () => {
      throw new Error('capture must not be called while the source work-item is still open');
    };
    const result = await runCloudResourceObligationSweepOnce(sql, { capture }, {
      evaluatedAtMs: CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS,
    });
    expect(result).toEqual({ candidates: 0, escalated: 0, errors: [] });
    expect(markCalls).toEqual([]);
  });

  it('names the still-open source work-item in the body when the ceiling overrides suppression', async () => {
    const row = makeRow({ id: 1, resourceId: 'held-too-long', createdAtMs: 0 });
    const { sql } = makeSweepFakeSql([row], [
      { workspaceId: row.workspaceId, featureId: row.sourceWorkItemId },
    ]);
    const bodies: string[] = [];
    const capture: CloudResourceObligationCaptureDep = async (input) => {
      bodies.push(input.body ?? '');
      return { ok: true, created: true, issue: { id: 'EI-ceiling' } };
    };
    const result = await runCloudResourceObligationSweepOnce(sql, { capture }, {
      evaluatedAtMs: CLOUD_RESOURCE_OBLIGATION_IN_USE_SUPPRESSION_CEILING_MS,
    });
    expect(result.escalated).toBe(1);
    // The reader must be told the owner may still be using it — not that it is abandoned.
    expect(bodies[0]).toContain('IS STILL OPEN');
    expect(bodies[0]).toContain(row.sourceWorkItemId);
  });

  it('falls back to escalating (and records the error) when the source-state probe fails', async () => {
    const row = makeRow({ id: 1, resourceId: 'probe-broken', createdAtMs: 0 });
    const { sql, markCalls } = makeSweepFakeSql([row], [], { failSourceRead: true });
    const capture: CloudResourceObligationCaptureDep = async () => ({
      ok: true,
      created: true,
      issue: { id: 'EI-fallback' },
    });
    const result = await runCloudResourceObligationSweepOnce(sql, { capture }, {
      evaluatedAtMs: CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS,
    });
    expect(result.escalated).toBe(1);
    expect(result.errors).toEqual([
      { id: 0, error: 'source work-item state read failed: work_items probe exploded' },
    ]);
    expect(markCalls).toEqual([{ id: 1, workItemId: 'EI-fallback' }]);
  });

  it('probes source state with the DERIVED terminal vocabulary, not a hand-copied list', async () => {
    // Guards the drift that once hid `dropped` from a sibling consumer for a month.
    const row = makeRow({ id: 1, createdAtMs: 0 });
    const seen: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('SELECT * FROM harness_shared.cloud_resource_obligations')) {
        return Promise.resolve([toDbRow(row)]);
      }
      if (text.includes('FROM harness_shared.work_items')) {
        seen.push(values);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    await runCloudResourceObligationSweepOnce(
      sql,
      { capture: async () => ({ ok: true, created: true, issue: { id: 'EI-x' } }) },
      { evaluatedAtMs: CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContainEqual([...ANY_FAMILY_TERMINAL_STATES]);
  });
});

describe('describeCloudResourceDeleteAddress', () => {
  it('addresses a nat through its region and owning router', () => {
    const result = describeCloudResourceDeleteAddress(makeRow());
    expect(result.addressable).toBe(true);
    if (!result.addressable) throw new Error('unreachable');
    expect(result.address).toEqual({
      op: 'delete-nat',
      projectId: 'active-alcove-504205-q3',
      resourceName: 'pc-p046-rel-nat',
      hostId: 'pc-p046-rel',
      region: 'us-central1',
      routerName: 'pc-p046-rel-router',
    });
  });

  it('addresses a vm by zone, and does not smuggle a region onto it', () => {
    const result = describeCloudResourceDeleteAddress(
      makeRow({ resourceKind: 'vm', resourceId: 'canary-vm', zone: 'us-central1-a', region: 'us-central1' }),
    );
    expect(result.addressable).toBe(true);
    if (!result.addressable) throw new Error('unreachable');
    expect(result.address.op).toBe('delete-instance');
    expect(result.address.zone).toBe('us-central1-a');
    expect(result.address).not.toHaveProperty('region');
    expect(result.address).not.toHaveProperty('routerName');
  });

  it('addresses a global kind with no zone or region at all', () => {
    const result = describeCloudResourceDeleteAddress(
      makeRow({ resourceKind: 'network', resourceId: 'pc-net', zone: '', region: '', parentResourceId: '' }),
    );
    expect(result.addressable).toBe(true);
    if (!result.addressable) throw new Error('unreachable');
    expect(result.address.op).toBe('delete-network');
  });

  it('names the MISSING field rather than returning a bare no — zonal kind without a zone', () => {
    const result = describeCloudResourceDeleteAddress(makeRow({ resourceKind: 'vm', zone: '' }));
    expect(result.addressable).toBe(false);
    if (result.addressable) throw new Error('unreachable');
    expect(result.op).toBe('delete-instance');
    expect(result.missing).toEqual(['zone']);
  });

  it('treats whitespace as absent, not as a value', () => {
    const result = describeCloudResourceDeleteAddress(makeRow({ region: '   ' }));
    expect(result.addressable).toBe(false);
    if (result.addressable) throw new Error('unreachable');
    expect(result.missing).toContain('region');
  });

  it('reports a kind the provider has no delete op for as unsupported, not as merely missing fields', () => {
    const result = describeCloudResourceDeleteAddress(makeRow({ resourceKind: 'snapshot' }));
    expect(result.addressable).toBe(false);
    if (result.addressable) throw new Error('unreachable');
    expect(result.op).toBeNull();
    expect(result.missing).toEqual(['unsupported-kind:snapshot']);
  });

  it('REGRESSION (WI-10001673): a 1040-era row — the shape of all four real production rows — cannot be addressed', () => {
    // Exactly what migration 1040 could store: no zone, no region, no router, no host.
    const legacy = makeRow({ zone: '', region: '', parentResourceId: '', hostId: '' });
    const result = describeCloudResourceDeleteAddress(legacy);
    expect(result.addressable).toBe(false);
    if (result.addressable) throw new Error('unreachable');
    // Both halves of the gap are named: the host identity every delete step carries, and
    // the location this kind is addressed by.
    expect(result.missing).toEqual(expect.arrayContaining(['hostId', 'region', 'parentResourceId']));
  });
});

describe('planCloudResourceObligationReclamation', () => {
  const reclaimable = (overrides: Partial<CloudResourceObligationRow> = {}) =>
    makeRow({ createdAtMs: 0, lastEscalatedAtMs: 1_000, sourceWorkItemId: 'WI-40474', ...overrides });
  const past = CLOUD_RESOURCE_OBLIGATION_DEFAULT_RECLAIM_AFTER_MS + 1;
  /** Source work-item established as TERMINAL: the set of still-open keys is empty. */
  const sourceClosed = { openSourceWorkItemKeys: new Set<string>() };

  it('deletes nothing before the reclaim TTL, and does not report it as blocked either', () => {
    const plan = planCloudResourceObligationReclamation([reclaimable()], 1_000, sourceClosed);
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.blocked).toHaveLength(0); // not yet due is not a finding
  });

  it('reclaims a past-due, escalated, addressable row whose source work-item is closed', () => {
    const plan = planCloudResourceObligationReclamation([reclaimable()], past, sourceClosed);
    expect(plan.blocked).toHaveLength(0);
    expect(plan.reclaim).toHaveLength(1);
    expect(plan.reclaim[0]!.address.op).toBe('delete-nat');
    expect(plan.reclaim[0]!.ageMs).toBe(past);
  });

  it('NEVER deletes a resource nobody was ever told about', () => {
    const plan = planCloudResourceObligationReclamation(
      [reclaimable({ lastEscalatedAtMs: null })],
      past,
      sourceClosed,
    );
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.blocked).toEqual([expect.objectContaining({ reason: 'never-escalated' })]);
  });

  it('blocks while the originating work-item is still open — no age-ceiling override for deletion', () => {
    const row = reclaimable();
    const openKeys = new Set([cloudResourceObligationSourceKey(row.workspaceId, row.sourceWorkItemId)]);
    // Far past even the in-use suppression ceiling that WOULD let escalation fire.
    const veryOld = CLOUD_RESOURCE_OBLIGATION_IN_USE_SUPPRESSION_CEILING_MS * 10;
    const plan = planCloudResourceObligationReclamation([row], veryOld, { openSourceWorkItemKeys: openKeys });
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.blocked).toEqual([expect.objectContaining({ reason: 'source-work-item-open' })]);
  });

  it('fails toward NOT deleting when the source work-item state could not be established', () => {
    // The escalation path treats "unestablished" as suppress-nothing (act). Reclamation must
    // do the OPPOSITE, because a wrong delete is unrecoverable.
    const plan = planCloudResourceObligationReclamation([reclaimable()], past, {});
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.blocked).toEqual([expect.objectContaining({ reason: 'source-work-item-open' })]);
  });

  it('reports a past-due row it cannot address as BLOCKED rather than dropping it silently', () => {
    const plan = planCloudResourceObligationReclamation(
      [reclaimable({ zone: '', region: '', parentResourceId: '', hostId: '' })],
      past,
      sourceClosed,
    );
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toBe('unaddressable');
    expect(plan.blocked[0]!.missing.length).toBeGreaterThan(0);
  });

  it('ignores closed and no-longer-owed obligations entirely', () => {
    const plan = planCloudResourceObligationReclamation(
      [reclaimable({ id: 1, closedAtMs: 5 }), reclaimable({ id: 2, resourceId: 'b', teardownOwed: false })],
      past,
      sourceClosed,
    );
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.blocked).toHaveLength(0);
  });

  it('orders oldest-first — the longest-standing obligation is the most expensive', () => {
    const plan = planCloudResourceObligationReclamation(
      [
        reclaimable({ id: 2, resourceId: 'newer', createdAtMs: 500 }),
        reclaimable({ id: 1, resourceId: 'older', createdAtMs: 0 }),
      ],
      past + 500,
      sourceClosed,
    );
    expect(plan.reclaim.map((c) => c.id)).toEqual([1, 2]);
  });

  it('is scoped strictly to the rows it is given — it can never propose an unledgered resource', () => {
    const plan = planCloudResourceObligationReclamation([], past, sourceClosed);
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.blocked).toHaveLength(0);
  });

  it('rejects a non-finite clock and a negative TTL rather than silently reclaiming everything', () => {
    expect(() => planCloudResourceObligationReclamation([], Number.NaN, {})).toThrow(/finite/);
    expect(() => planCloudResourceObligationReclamation([], 0, { reclaimAfterMs: -1 })).toThrow(/non-negative/);
  });

  it('ASYMMETRY: the same row the escalation path acts on, the reclamation path refuses', () => {
    // One row, one clock, unestablished source state. Escalation fires (cheap, reversible);
    // reclamation blocks (unrecoverable). Encoding it here so the two can never be
    // "harmonised" into agreeing by a later edit.
    const row = reclaimable({ lastEscalatedAtMs: null });
    const clock = past;
    expect(selectCloudResourceObligationsToEscalate([row], clock)).toHaveLength(1);
    expect(planCloudResourceObligationReclamation([row], clock, {}).reclaim).toHaveLength(0);
  });
});

/**
 * WI-10001673 — the MAPPING, which is the step nothing else can catch.
 *
 * The provider-side guards in `gcp-provider.test.ts` prove the creation EVENT carries the
 * address, and `describeCloudResourceDeleteAddress` above proves a ROW bearing one is
 * addressable. Both keep passing if this observer drops the field in between — which is exactly
 * what it did: `hostId` was read from the process-wide BINDING (constructed once in
 * dbos/bootstrap.ts, where no host is in scope), so it spread to nothing on every event and all
 * 23 rows created after migration 1168 were born `host_id=''`, unreclaimable by construction.
 */
describe('createCloudResourceObligationObserver address mapping', () => {
  function makeInsertCapture() {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push({ text, values });
      // The recorder falls back to a SELECT when the INSERT returns nothing, and throws if that
      // is also empty. Returning [] here would fail these tests inside the recorder, before any
      // assertion ran — an instrument fault that reads exactly like a mapping defect.
      if (text.includes('INSERT INTO harness_shared.cloud_resource_obligations')) {
        return Promise.resolve([{ id: 1, inserted: true }]);
      }
      throw new Error(`unexpected query in fake sql: ${text}`);
    }) as unknown as Parameters<typeof createCloudResourceObligationObserver>[0]['sql'];
    return { sql, calls };
  }

  function createdEvent(overrides: Partial<CloudResourceCreatedEventLike> = {}): CloudResourceCreatedEventLike {
    return {
      resource: { kind: 'nat', providerId: 'pc-host-gcp-1-nat', parentProviderId: 'proj-1', region: 'us-central1' },
      workspaceId: 'papercusp-workspace',
      hostId: 'host-gcp-1',
      parentResourceId: 'pc-host-gcp-1-router',
      ...overrides,
    };
  }

  it('carries the host id from the EVENT into the recorded row', async () => {
    const { sql, calls } = makeInsertCapture();
    await createCloudResourceObligationObserver({ sql })(createdEvent());

    // Positive control: a fake that captured nothing would make every assertion below vacuous.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('INSERT INTO harness_shared.cloud_resource_obligations');
    expect(calls[0]?.values).toContain('host-gcp-1');
  });

  it('carries the owning router so a NAT row can be addressed through it', async () => {
    const { sql, calls } = makeInsertCapture();
    await createCloudResourceObligationObserver({ sql })(createdEvent());
    expect(calls[0]?.values).toContain('pc-host-gcp-1-router');
  });

  it('does not invent a parent for a kind addressed directly', async () => {
    const { sql, calls } = makeInsertCapture();
    await createCloudResourceObligationObserver({ sql })(
      createdEvent({
        resource: { kind: 'network', providerId: 'pc-host-gcp-1-net', parentProviderId: 'proj-1' },
        parentResourceId: '',
      }),
    );
    // Negative control for the assertion above: it must be the EVENT's router that lands, not a
    // constant stamped onto every row.
    expect(calls[0]?.values).not.toContain('pc-host-gcp-1-router');
    expect(calls[0]?.values).toContain('host-gcp-1');
  });

  it('prefers the event host over a binding host — one provider serves many hosts', async () => {
    const { sql, calls } = makeInsertCapture();
    await createCloudResourceObligationObserver({ sql, hostId: 'host-from-binding' })(createdEvent());
    expect(calls[0]?.values).toContain('host-gcp-1');
    expect(calls[0]?.values).not.toContain('host-from-binding');
  });

  /**
   * BINDING-ONLY CONTROL — the exact pre-fix mapping, kept permanently so the four assertions
   * above can be SHOWN to fail on it, in the same spirit as the PREFIX-STRIP CONTROL in
   * cloud-resource-obligations.close-observer.test.ts.
   *
   * This is not ceremony: those four were written AFTER the fix and passed on first run, so
   * nothing else in the suite distinguishes "the mapping works" from "the assertions cannot
   * fail". Production wiring supplies no binding host, so the `hostId` spread below is dead on
   * every event — which is how 23 consecutive rows were written unaddressable while this
   * module's own unit tests stayed green.
   */
  it('CONTROL: the pre-fix binding-only mapping drops the address the assertions above require', async () => {
    const { sql, calls } = makeInsertCapture();
    const binding: { sql: typeof sql; hostId?: string } = { sql };
    const preFixObserver = async (event: CloudResourceCreatedEventLike) => {
      await recordCloudResourceObligation(binding.sql, {
        workspaceId: event.workspaceId,
        provider: 'gcp',
        resourceKind: event.resource.kind,
        resourceId: event.resource.providerId,
        ...(event.resource.region ? { region: event.resource.region } : {}),
        ...(binding.hostId ? { hostId: binding.hostId } : {}),
      });
    };

    await preFixObserver(createdEvent());

    // Positive control: the row IS still written, and its non-address fields still land — the
    // defect was never a failed write, which is precisely why it went unnoticed for 23 rows.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toContain('pc-host-gcp-1-nat');
    expect(calls[0]?.values).toContain('us-central1');

    // ...but the address does not, so every assertion in this describe block would fail.
    expect(calls[0]?.values).not.toContain('host-gcp-1');
    expect(calls[0]?.values).not.toContain('pc-host-gcp-1-router');
  });
});
