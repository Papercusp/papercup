import { describe, expect, it, vi } from 'vitest';
import { assignCohort, type PilotArm } from './pilot-arm-assignment.js';
import {
  collectPilotCohort,
  DEFAULT_PILOT_RUBRIC,
  materializePilotCohort,
  PILOT_STAMP_KEYS,
  readArmBGateProbeProof,
  type CollectPilotCohortInput,
  type ParticipantCost,
  type PilotCohortDeps,
  type UsageWindow,
} from './pilot-cohort.js';
import { validatePilotParticipantReceiptCohort } from './pilot-participant-receipts.js';
import { buildPilotFanInPlan, type PilotComposedAwaitReceipt } from './pilot-fan-in-guards.js';
import type {
  PilotArmBProbeRow,
  PilotMaterializationAuditInput,
  PilotMaterializationPatch,
  PilotMaterializationRow,
  PilotMaterializationScope,
  PilotMaterializationStore,
  PilotMaterializationTransaction,
} from './pilot-materialization-core.js';
import type {
  CanonicalPilotParticipant,
  PilotParticipantBindingReceipt,
  PilotParticipantDispatchReceipt,
  PilotParticipantRole,
} from './pilot-participant-receipts.js';
import type { ScorecardRow } from './scorecards.js';
import type { WorkItem } from './work-items.js';

const IDS = Array.from({ length: 21 }, (_, index) => `WI-${String(index + 1).padStart(3, '0')}`);
const SEED = 'p-020-integration-seed';
const TAKEN_AT = '2026-08-27T05:00:00.000Z';
const CLOSED_AT = '2026-08-27T06:00:00.000Z';
const CLOSED_AT_MS = Date.parse(CLOSED_AT);
const CURRENT_SHA = 'a'.repeat(40);

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id,
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    state: 'open',
    title: id,
    summary: '',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'minor',
    goalId: null,
    tags: null,
    sourcePlanSlug: null,
    sourcePlanItemIds: null,
    redundancy: null,
    expectedCostCents: null,
    parent: null,
    payload: {},
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    closedAt: null,
    ...over,
  }) as WorkItem;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function participantReceipts(
  id: string,
  arm: PilotArm,
  index: number,
): {
  assignee: string;
  bindings: PilotParticipantBindingReceipt[];
  dispatches: PilotParticipantDispatchReceipt[];
  participants: CanonicalPilotParticipant[];
} {
  const roles: PilotParticipantRole[] = arm === 'C' ? ['director', 'implementer'] : ['solo'];
  const bindings = roles.map(
    (role, roleIndex): PilotParticipantBindingReceipt => ({
      receiptId: `binding-${id}-${role}`,
      itemId: id,
      ownerId: `su-${id}-${role}`,
      sessionId: `session-${id}-${role}`,
      role,
      claimVersion: TAKEN_AT,
      bindingIssuedAtMs: CLOSED_AT_MS - 10_000 + index * 10 + roleIndex,
    }),
  );
  const dispatches = bindings.map(
    (binding): PilotParticipantDispatchReceipt => ({
      receiptId: `dispatch-${id}-${binding.role}`,
      bindingReceiptId: binding.receiptId,
      itemId: binding.itemId,
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
      role: binding.role,
      dispatchedAtMs: binding.bindingIssuedAtMs + 100,
    }),
  );
  const participants = bindings.map(
    (binding, roleIndex): CanonicalPilotParticipant => ({
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
      role: binding.role,
      bindingReceiptId: binding.receiptId,
      dispatchReceiptId: dispatches[roleIndex]!.receiptId,
    }),
  );
  return {
    assignee: bindings.at(-1)!.ownerId,
    bindings,
    dispatches,
    participants,
  };
}

class FakeMaterializationStore implements PilotMaterializationStore {
  readonly rows = new Map<string, PilotMaterializationRow>();
  readonly audits: PilotMaterializationAuditInput[] = [];
  probe: PilotArmBProbeRow = {
    id: 'WI-PROBE',
    status: 'passed',
    updatedTs: 5,
    payload: {
      pilotArmBGateProbe: {
        status: 'passed',
        judgementPersisted: true,
        testedSha: CURRENT_SHA,
        deployedSha: CURRENT_SHA,
      },
    },
  };

  constructor(rows: readonly PilotMaterializationRow[]) {
    for (const row of rows) this.rows.set(row.id, clone(row));
  }

  async transaction<T>(fn: (tx: PilotMaterializationTransaction) => Promise<T>): Promise<T> {
    const beforeRows = clone([...this.rows.entries()]);
    const beforeAudits = clone(this.audits);
    const tx: PilotMaterializationTransaction = {
      lockRows: async (_scope, ids) =>
        ids.map((id) => clone(this.rows.get(id))).filter(Boolean) as PilotMaterializationRow[],
      unresolvedBlockerIds: async () => [],
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
        row.takenAt === patch.expectedTakenAt,
      );
    });
    if (!eligible) return [];
    return patches.map((patch) => {
      const row = this.rows.get(patch.id)!;
      const updated = {
        ...row,
        updatedTs: patch.nextUpdatedTs,
        payload: { ...row.payload, ...clone(patch.payloadPatch) },
      };
      this.rows.set(patch.id, updated);
      return clone(updated);
    });
  }
}

function materializationFixture() {
  const assignment = assignCohort(
    IDS.map((id) => ({ id, tier: 'substantive' as const })),
    SEED,
  );
  const armById = new Map(assignment.assignments.map((row) => [row.id, row.arm]));
  const rows = IDS.map((id, index): PilotMaterializationRow => {
    const receipts = participantReceipts(id, armById.get(id)!, index);
    return {
      id,
      status: 'open',
      kind: 'change',
      updatedTs: 100 + index,
      assignee: receipts.assignee,
      takenAt: TAKEN_AT,
      payload: {
        untouched: `row-${index}`,
        pilotBindingReceipts: receipts.bindings,
        pilotDispatchReceipts: receipts.dispatches,
      },
    };
  });
  const store = new FakeMaterializationStore(rows);
  return {
    rows,
    store,
    input: {
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      actor: 'su-operator',
      seed: SEED,
      probeItemId: 'WI-PROBE',
      candidates: rows.map((row) => ({
        id: row.id,
        tier: 'substantive' as const,
        expectedUpdatedTs: row.updatedTs,
        expectedAssignee: row.assignee!,
        expectedTakenAt: row.takenAt!,
      })),
    },
    deps: {
      store,
      receiptAuthority: { validate: validatePilotParticipantReceiptCohort },
      loadCurrentReleasePin: async () => ({
        deployedSha: CURRENT_SHA,
        greenPinSha: CURRENT_SHA,
        capturedAtMs: 1_500,
      }),
      now: () => 2_000,
    },
  };
}

function scorecard(id: string, graderOwnerId: string, index: number): ScorecardRow {
  return {
    issueId: `SC-${id}`,
    createdAt: new Date(CLOSED_AT_MS + 1_000 + index).toISOString(),
    createdBy: graderOwnerId,
    subject: { kind: 'work-item', ref: id },
    rubricRef: DEFAULT_PILOT_RUBRIC,
    ratings: { quality: { rating: 'good', evidence: 'verified against the frozen packet' } },
    nKeys: 1,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    gradingAudit: {
      state: 'passed',
      metaRubricRef: 'grading-integrity',
      stampedAt: new Date(CLOSED_AT_MS + 2_000 + index).toISOString(),
      auditIssueId: `AUDIT-${id}`,
      auditor: `auditor-${id}`,
    },
    synthesized: false,
    score10: 6 + (index % 4),
    linkedItems: [],
  };
}

function composedReceipts(roots: ReturnType<typeof buildPilotFanInPlan>['gradingRoots']): PilotComposedAwaitReceipt[] {
  return roots.map((root, index) => ({
    kind: root.kind,
    batchIndex: root.batchIndex,
    rootFingerprint: root.rootFingerprint,
    rootId: 100 + index,
    anchorAwaitId: 200 + index,
    leafCount: root.itemIds.length,
    registeredAtMs: 3_000 + index,
  }));
}

function collectionFixture(): {
  rows: Map<string, WorkItem>;
  scorecards: ScorecardRow[];
  input: CollectPilotCohortInput;
  deps: PilotCohortDeps;
} {
  const assignment = assignCohort(
    IDS.map((id) => ({ id, tier: 'substantive' as const })),
    SEED,
  );
  const assignmentById = new Map(assignment.assignments.map((row) => [row.id, row]));
  const rows = new Map<string, WorkItem>();
  const scorecards: ScorecardRow[] = [];
  const gradeBindings: CollectPilotCohortInput['gradeBindings'][number][] = [];
  const gradeCardReceipts: CollectPilotCohortInput['gradeCardReceipts'][number][] = [];

  IDS.forEach((id, index) => {
    const assigned = assignmentById.get(id)!;
    const receipts = participantReceipts(id, assigned.arm, index);
    const graderOwnerId = `su-grader-${id}`;
    rows.set(
      id,
      item(id, {
        state: 'done',
        assignee: receipts.assignee,
        takenAt: TAKEN_AT,
        closedAt: CLOSED_AT,
        completionAuthority: 'committed',
        payload: {
          pilotArm: assigned.arm,
          pilotSeed: SEED,
          pilotStratum: assigned.stratum,
          pilotBlockIndex: assigned.blockIndex,
          pilotPartialBlock: assigned.partialBlock,
          pilotAssignedAtMs: CLOSED_AT_MS - 20_000,
          pilotParticipants: receipts.participants,
          pilotBindingReceipts: receipts.bindings,
          pilotDispatchReceipts: receipts.dispatches,
        },
      }),
    );
    gradeBindings.push({
      itemId: id,
      graderOwnerId,
      packetFingerprint: (index % 16).toString(16).repeat(64),
    });
    scorecards.push(scorecard(id, graderOwnerId, index));
    gradeCardReceipts.push({ itemId: id, cardId: `SC-${id}` });
  });

  const fanInPlan = buildPilotFanInPlan({ itemIds: IDS, rubricRef: DEFAULT_PILOT_RUBRIC });
  const input: CollectPilotCohortInput = {
    workspaceId: 'papercusp-workspace',
    harness: 'papercusp',
    itemIds: IDS,
    operatorOwnerId: 'su-operator',
    runbookAuthorOwnerId: 'su-runbook-author',
    gradeBindings,
    gradeCardReceipts,
    completionExactReceipts: fanInPlan.completionExactLeaves.map((leaf, index) => ({
      ...leaf,
      awaitId: index + 1,
      registeredAtMs: 1_000 + index,
    })),
    gradingComposedReceipts: composedReceipts(fanInPlan.gradingRoots),
  };
  const deps: PilotCohortDeps = {
    getWorkItem: vi.fn(async (id: string) => rows.get(id) ?? null) as unknown as PilotCohortDeps['getWorkItem'],
    listScorecards: vi.fn(async () => scorecards),
    readUsageCosts: vi.fn(
      async (_workspaceId: string, windows: readonly UsageWindow[]) =>
        new Map<string, ParticipantCost>(
          windows.map((window): [string, ParticipantCost] => [
            window.key,
            { key: window.key, sampleCount: 1, unpricedCount: 0, costUsd: 0.25 },
          ]),
        ),
    ),
  };
  return { rows, scorecards, input, deps };
}

describe('pilot cohort materialization integration', () => {
  it('previews the exact 21-item cohort and its deterministic 20+1 fan-in plan without storage', async () => {
    const result = await materializePilotCohort({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      actor: 'su-operator',
      seed: SEED,
      candidates: IDS.map((id) => ({ id, tier: 'substantive' })),
    });

    expect(result).toMatchObject({ ok: true, committed: false, applied: [], rolledBack: [] });
    expect(result.plan.assignments).toHaveLength(21);
    expect(result.plan.balance).toEqual({ A: 7, B: 7, C: 7 });
    expect(result.fanInPlan.completionExactLeaves).toHaveLength(21);
    expect(result.fanInPlan.completionRoots.map((root) => root.itemIds.length)).toEqual([20, 1]);
    expect(result.fanInPlan.gradingRoots.map((root) => root.itemIds.length)).toEqual([20, 1]);
  });

  it('requires exact frozen row and claim versions before entering the atomic boundary', async () => {
    await expect(
      materializePilotCohort({
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'papercusp',
        actor: 'su-operator',
        seed: SEED,
        candidates: IDS.map((id) => ({ id, tier: 'substantive' })),
        confirm: true,
      }),
    ).rejects.toThrow('confirm requires expectedUpdatedTs, expectedAssignee, and expectedTakenAt');
  });

  it('atomically stamps all 21 rows from canonical receipts and returns the durable receipt', async () => {
    const fixture = materializationFixture();
    const result = await materializePilotCohort({ ...fixture.input, confirm: true }, fixture.deps);

    expect(result).toMatchObject({ ok: true, committed: true, applied: IDS, rolledBack: [] });
    expect(result.receipt).toMatchObject({ ids: IDS });
    for (const row of fixture.store.rows.values()) {
      for (const key of PILOT_STAMP_KEYS) expect(row.payload).toHaveProperty(key);
      expect(row.payload.untouched).toMatch(/^row-/);
    }
    expect(fixture.store.audits.map((audit) => audit.action)).toEqual(['pilot.materialize']);
  });
});

describe('pilot cohort collection integration', () => {
  it('collects only the exact receipt-bound grades, receipt-derived costs, and registered fan-in cohort', async () => {
    const fixture = collectionFixture();
    const result = await collectPilotCohort(fixture.input, fixture.deps);

    expect(result.complete).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.observationCount).toBe(21);
    expect(result.assignmentVerification.ok).toBe(true);
    expect(result.fanInPlan?.completionRoots.map((root) => root.itemIds.length)).toEqual([20, 1]);
    const paired = result.items.find((entry) => entry.arm === 'C');
    expect(paired?.participantCosts).toHaveLength(2);
    expect(paired?.participantCosts.every((cost) => cost.costUsd === 0.25)).toBe(true);
  });

  it('rejects duplicate plausible cards instead of selecting the first scorecard', async () => {
    const fixture = collectionFixture();
    const first = fixture.scorecards[0]!;
    fixture.scorecards.push({
      ...first,
      issueId: `${first.issueId}-DUPLICATE`,
      createdAt: new Date(Date.parse(first.createdAt) + 1).toISOString(),
    });

    const result = await collectPilotCohort(fixture.input, fixture.deps);

    expect(result.complete).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({ itemId: IDS[0], code: 'duplicate-scorecard' }));
    expect(result.items.some((entry) => entry.itemId === IDS[0])).toBe(false);
  });

  it('reports a stamp that diverges from canonical binding and dispatch receipts', async () => {
    const fixture = collectionFixture();
    const first = fixture.rows.get(IDS[0]!)!;
    const payload = clone(first.payload as Record<string, unknown>);
    const participants = clone(payload.pilotParticipants as CanonicalPilotParticipant[]);
    participants[0] = { ...participants[0]!, ownerId: 'caller-forged-owner' };
    fixture.rows.set(first.id, { ...first, payload: { ...payload, pilotParticipants: participants } });

    const result = await collectPilotCohort(fixture.input, fixture.deps);

    expect(result.complete).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({ itemId: IDS[0], code: 'participant-stamp-mismatch' }));
  });

  it('requires exactly one completion registration route while keeping grading at composed 20+1', async () => {
    const fixture = collectionFixture();
    const plan = buildPilotFanInPlan({ itemIds: IDS, rubricRef: DEFAULT_PILOT_RUBRIC });
    const result = await collectPilotCohort(
      {
        ...fixture.input,
        completionComposedReceipts: composedReceipts(plan.completionRoots),
      },
      fixture.deps,
    );

    expect(result.complete).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'invalid-fan-in-route' }));
  });
});

describe('arm-B probe proof', () => {
  it('requires a terminal item, persisted judgement, and tested/deployed SHA parity', () => {
    const proof = item('WI-PROBE', {
      state: 'done',
      closedAt: new Date().toISOString(),
      payload: {
        out: {
          pilotArmBGateProbe: {
            status: 'passed',
            testedSha: 'abc',
            deployedSha: 'abc',
            judgementPersisted: true,
          },
        },
      },
    });
    expect(readArmBGateProbeProof(proof)).toEqual({
      status: 'passed',
      testedSha: 'abc',
      deployedSha: 'abc',
      judgementPersisted: true,
    });
    expect(
      readArmBGateProbeProof({
        ...proof,
        payload: {
          out: {
            pilotArmBGateProbe: {
              status: 'passed',
              testedSha: 'abc',
              deployedSha: 'def',
              judgementPersisted: true,
            },
          },
        },
      }),
    ).toBeNull();
  });
});
