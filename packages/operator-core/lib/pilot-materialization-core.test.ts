import { describe, expect, it } from 'vitest';
import {
  PILOT_MATERIALIZATION_KEYS,
  materializePilotCohort,
  type CanonicalParticipantReceiptAuthority,
  type FrozenPilotCandidate,
  type MaterializePilotCohortInput,
  type PilotArmBProbeRow,
  type PilotMaterializationAuditInput,
  type PilotMaterializationDependencies,
  type PilotMaterializationPatch,
  type PilotMaterializationRow,
  type PilotMaterializationScope,
  type PilotMaterializationStore,
  type PilotMaterializationTransaction,
} from './pilot-materialization-core';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TAKEN_AT = '2026-08-27T05:00:00.000Z';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeStore implements PilotMaterializationStore {
  readonly rows = new Map<string, PilotMaterializationRow>();
  readonly audits: PilotMaterializationAuditInput[] = [];
  readonly blocked = new Set<string>();
  probe: PilotArmBProbeRow = {
    id: 'WI-PROBE',
    status: 'passed',
    updatedTs: 5,
    payload: {
      pilotArmBGateProbe: {
        status: 'passed',
        judgementPersisted: true,
        testedSha: SHA_A,
        deployedSha: SHA_A,
      },
    },
  };

  private tail: Promise<void> = Promise.resolve();

  constructor(rows: readonly PilotMaterializationRow[]) {
    for (const row of rows) this.rows.set(row.id, clone(row));
  }

  async transaction<T>(fn: (tx: PilotMaterializationTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const beforeRows = clone([...this.rows.entries()]);
    const beforeAudits = clone(this.audits);
    const tx: PilotMaterializationTransaction = {
      lockRows: async (_scope, ids) =>
        ids.map((id) => clone(this.rows.get(id))).filter(Boolean) as PilotMaterializationRow[],
      unresolvedBlockerIds: async (_scope, ids) => ids.filter((id) => this.blocked.has(id)),
      readProbe: async (_scope, id) => (id === this.probe.id ? clone(this.probe) : null),
      casApply: async (_scope, patches) => this.casApply(patches),
      appendAudit: async (input) => {
        this.audits.push(clone(input));
      },
    };
    try {
      return await fn(tx);
    } catch (error) {
      this.rows.clear();
      for (const [id, row] of beforeRows) this.rows.set(id, row);
      this.audits.splice(0, this.audits.length, ...beforeAudits);
      throw error;
    } finally {
      release();
    }
  }

  async readRows(
    _scope: PilotMaterializationScope,
    ids: readonly string[],
  ): Promise<readonly PilotMaterializationRow[]> {
    return ids.map((id) => clone(this.rows.get(id))).filter(Boolean) as PilotMaterializationRow[];
  }

  async appendAbortAudit(input: PilotMaterializationAuditInput): Promise<void> {
    this.audits.push(clone(input));
  }

  private casApply(patches: readonly PilotMaterializationPatch[]): PilotMaterializationRow[] {
    const eligible = patches.every((patch) => {
      const row = this.rows.get(patch.id);
      return Boolean(
        row &&
        row.status === 'open' &&
        row.updatedTs === patch.expectedUpdatedTs &&
        row.assignee === patch.expectedAssignee &&
        row.takenAt === patch.expectedTakenAt &&
        row.payload._claimHold !== true &&
        row.payload._claimHold !== 'true' &&
        !PILOT_MATERIALIZATION_KEYS.some((key) => Object.hasOwn(row.payload, key)) &&
        !this.blocked.has(patch.id),
      );
    });
    if (!eligible) return [];
    const out: PilotMaterializationRow[] = [];
    for (const patch of patches) {
      const prior = this.rows.get(patch.id)!;
      const next = {
        ...prior,
        updatedTs: patch.nextUpdatedTs,
        payload: { ...prior.payload, ...clone(patch.payloadPatch) },
      };
      this.rows.set(patch.id, next);
      out.push(clone(next));
    }
    return out;
  }
}

function fixtureRows(): PilotMaterializationRow[] {
  return Array.from({ length: 21 }, (_, index) => ({
    id: 'WI-' + String(index + 1).padStart(3, '0'),
    status: 'open',
    kind: 'change',
    updatedTs: 100 + index,
    assignee: 'su-' + String(index + 1),
    takenAt: TAKEN_AT,
    payload: {
      untouched: 'row-' + index,
      pilotBindingReceipts: [{ receiptId: 'b-' + index }],
      pilotDispatchReceipts: [{ receiptId: 'd-' + index }],
    },
  }));
}

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
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    actor: 'su-test',
    seed: 'p-018-seed',
    armBProbeItemId: 'WI-PROBE',
    candidates,
  };
}

const receiptAuthority: CanonicalParticipantReceiptAuthority = {
  validate: (candidates) => {
    const errors: string[] = [];
    const participantsByItem: Record<string, unknown[]> = {};
    for (const candidate of candidates) {
      const payload = candidate.payload as Record<string, unknown>;
      const bindings = payload?.pilotBindingReceipts;
      const dispatches = payload?.pilotDispatchReceipts;
      if (!Array.isArray(bindings) || bindings.length === 0) errors.push(candidate.id + ': binding receipt missing');
      if (!Array.isArray(dispatches) || dispatches.length === 0)
        errors.push(candidate.id + ': dispatch receipt missing');
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

function dependencies(store: FakeStore, overrides: Partial<PilotMaterializationDependencies> = {}) {
  return {
    store,
    receiptAuthority,
    loadCurrentReleasePin: async () => ({
      deployedSha: SHA_A,
      greenPinSha: SHA_A,
      capturedAtMs: 1_500,
    }),
    now: () => 2_000,
    ...overrides,
  } satisfies PilotMaterializationDependencies;
}

describe('pilot materialization core', () => {
  it('materializes exactly 21 rows with all seven keys and an exact current-pin receipt', async () => {
    const rows = fixtureRows();
    const store = new FakeStore(rows);
    const result = await materializePilotCohort(fixtureInput(rows), dependencies(store));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.ids).toHaveLength(21);
    expect(result.receipt.armBProof).toMatchObject({
      testedSha: SHA_A,
      claimedDeployedSha: SHA_A,
      actualDeployedSha: SHA_A,
      greenPinSha: SHA_A,
      currentPinCapturedAtMs: 1_500,
    });
    for (const row of store.rows.values()) {
      for (const key of PILOT_MATERIALIZATION_KEYS) expect(row.payload).toHaveProperty(key);
      expect(row.payload.untouched).toMatch(/^row-/);
    }
    expect(store.audits.map((audit) => audit.action)).toEqual(['pilot.materialize']);
  });

  it('fails closed on one stale row version and leaves every row byte-exact', async () => {
    const rows = fixtureRows();
    const store = new FakeStore(rows);
    const input = fixtureInput(rows);
    const stale = {
      ...input,
      candidates: input.candidates.map((candidate, index) =>
        index === 7 ? { ...candidate, expectedUpdatedTs: candidate.expectedUpdatedTs - 1 } : candidate,
      ),
    };

    const result = await materializePilotCohort(stale, dependencies(store));
    expect(result.ok).toBe(false);
    expect([...store.rows.values()]).toEqual(rows);
    if (result.ok) return;
    expect(result.receipt.touchedIds).toEqual([]);
    expect(result.receipt.rollbackVerified).toBe(true);
    expect(result.receipt.auditPersisted).toBe(true);
  });

  it('permits exactly one winner under concurrent cohort CAS', async () => {
    const rows = fixtureRows();
    const store = new FakeStore(rows);
    const input = fixtureInput(rows);
    const [left, right] = await Promise.all([
      materializePilotCohort(input, dependencies(store)),
      materializePilotCohort(input, dependencies(store)),
    ]);

    expect([left.ok, right.ok].sort()).toEqual([false, true]);
    expect([...store.rows.values()].filter((row) => Object.hasOwn(row.payload, 'pilotArm'))).toHaveLength(21);
    expect(store.audits.filter((audit) => audit.action === 'pilot.materialize')).toHaveLength(1);
    expect(store.audits.filter((audit) => audit.action === 'pilot.materialize.abort')).toHaveLength(1);
  });

  it('rejects a stale deployed/current-green proof before any stamp is visible', async () => {
    const rows = fixtureRows();
    const store = new FakeStore(rows);
    const result = await materializePilotCohort(
      fixtureInput(rows),
      dependencies(store, {
        loadCurrentReleasePin: async () => ({
          deployedSha: SHA_B,
          greenPinSha: SHA_B,
          capturedAtMs: 1_500,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect([...store.rows.values()]).toEqual(rows);
    if (!result.ok) expect(result.receipt.reason).toContain('current-pin proof failed');
  });

  it('rolls back a post-update failure, verifies every touched preimage, and persists an abort receipt', async () => {
    const rows = fixtureRows();
    const store = new FakeStore(rows);
    const result = await materializePilotCohort(
      fixtureInput(rows),
      dependencies(store, {
        afterApply: () => {
          throw new Error('injected post-update failure');
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect([...store.rows.values()]).toEqual(rows);
    if (result.ok) return;
    expect(result.receipt.reason).toContain('injected post-update failure');
    expect(result.receipt.touchedIds).toHaveLength(21);
    expect(result.receipt.rollbackVerified).toBe(true);
    expect(result.receipt.rollbackMismatches).toEqual([]);
    expect(result.receipt.auditPersisted).toBe(true);
    expect(store.audits.at(-1)?.action).toBe('pilot.materialize.abort');
  });

  it('requires canonical binding and dispatch receipt evidence for every frozen row', async () => {
    const rows = fixtureRows();
    rows[9] = { ...rows[9], payload: { ...rows[9].payload, pilotBindingReceipts: [] } };
    const store = new FakeStore(rows);
    const result = await materializePilotCohort(fixtureInput(rows), dependencies(store));

    expect(result.ok).toBe(false);
    expect([...store.rows.values()]).toEqual(rows);
    if (!result.ok) expect(result.receipt.reason).toContain('canonical participant receipts failed');
  });
});
