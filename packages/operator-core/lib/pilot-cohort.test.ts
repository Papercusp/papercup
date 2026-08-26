import { describe, expect, it, vi } from 'vitest';
import { assignCohort } from './pilot-arm-assignment.js';
import {
  collectPilotCohort,
  materializePilotCohort,
  readArmBGateProbeProof,
  type ParticipantCost,
  type PilotAssignmentCandidate,
  type PilotCohortDeps,
  type UsageWindow,
} from './pilot-cohort.js';
import type { ScorecardRow } from './scorecards.js';
import type { WorkItem } from './work-items.js';

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

const baseDeps = (rows: Map<string, WorkItem>): PilotCohortDeps => ({
  getWorkItem: vi.fn(async (id: string) => rows.get(id) ?? null),
  mergeWorkItemPayload: vi.fn(async (id: string, patch: Record<string, unknown>, opts = {}) => {
    const current = rows.get(id);
    if (!current) return null;
    const payload = { ...((current.payload ?? {}) as Record<string, unknown>), ...patch };
    for (const key of opts.unset ?? []) delete payload[key];
    const updated = { ...current, payload };
    rows.set(id, updated);
    return updated;
  }),
  listScorecards: vi.fn(async () => []),
  readUsageCosts: vi.fn(async () => new Map()),
  nowMs: () => 1_000,
});

describe('pilot cohort materialization', () => {
  it('previews deterministically without writing', async () => {
    const rows = new Map(['WI-1', 'WI-2', 'WI-3'].map((id) => [id, item(id)]));
    const deps = baseDeps(rows);
    const candidates = [...rows.keys()].map((id) => ({ id, tier: 'substantive' as const }));

    const result = await materializePilotCohort({ seed: 'seed', candidates }, deps);

    expect(result).toMatchObject({ ok: true, committed: false });
    expect(result.plan.balance).toEqual({ A: 1, B: 1, C: 1 });
    expect(deps.mergeWorkItemPayload).not.toHaveBeenCalled();
  });

  it('refuses every write when arm B lacks a live tested=deployed proof', async () => {
    const rows = new Map(['WI-1', 'WI-2', 'WI-3'].map((id) => [id, item(id)]));
    const deps = baseDeps(rows);
    const candidates = [...rows.keys()].map((id) => ({ id, tier: 'substantive' as const }));

    const result = await materializePilotCohort({ seed: 'seed', candidates, confirm: true }, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('pilotArmBGateProbe');
    expect(deps.mergeWorkItemPayload).not.toHaveBeenCalled();
  });

  it('materializes participant-bound assignments and verifies the stored cohort', async () => {
    const ids = ['WI-1', 'WI-2', 'WI-3'];
    const rows = new Map(ids.map((id) => [id, item(id)]));
    rows.set(
      'WI-PROBE',
      item('WI-PROBE', {
        state: 'done',
        closedAt: new Date(900).toISOString(),
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
      }),
    );
    const plan = assignCohort(
      ids.map((id) => ({ id, tier: 'substantive' })),
      'seed',
    );
    const armById = new Map(plan.assignments.map((assignment) => [assignment.id, assignment.arm]));
    const candidates: PilotAssignmentCandidate[] = ids.map((id) => ({
      id,
      tier: 'substantive',
      participants:
        armById.get(id) === 'C'
          ? [
              { ownerId: `${id}-d`, sessionId: `${id}-ds`, role: 'director', windowStartMs: 1_000 },
              { ownerId: `${id}-i`, sessionId: `${id}-is`, role: 'implementer', windowStartMs: 1_000 },
            ]
          : [{ ownerId: `${id}-s`, sessionId: `${id}-ss`, role: 'solo', windowStartMs: 1_000 }],
    }));
    const deps = baseDeps(rows);

    const result = await materializePilotCohort(
      { seed: 'seed', candidates, probeItemId: 'WI-PROBE', confirm: true },
      deps,
    );

    expect(result).toMatchObject({ ok: true, committed: true, applied: ids, rolledBack: [] });
    expect(rows.get('WI-1')?.payload).toMatchObject({ pilotSeed: 'seed', pilotAssignedAtMs: 1_000 });
  });

  it('removes every pilot key it added when a later cohort write fails', async () => {
    const ids = ['WI-1', 'WI-2', 'WI-3'];
    const rows = new Map(ids.map((id) => [id, item(id)]));
    rows.set(
      'WI-PROBE',
      item('WI-PROBE', {
        state: 'done',
        closedAt: new Date(900).toISOString(),
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
      }),
    );
    const plan = assignCohort(
      ids.map((id) => ({ id, tier: 'substantive' })),
      'seed',
    );
    const armById = new Map(plan.assignments.map((assignment) => [assignment.id, assignment.arm]));
    const candidates: PilotAssignmentCandidate[] = ids.map((id) => ({
      id,
      tier: 'substantive',
      participants:
        armById.get(id) === 'C'
          ? [
              { ownerId: `${id}-d`, sessionId: `${id}-ds`, role: 'director', windowStartMs: 1_000 },
              { ownerId: `${id}-i`, sessionId: `${id}-is`, role: 'implementer', windowStartMs: 1_000 },
            ]
          : [{ ownerId: `${id}-s`, sessionId: `${id}-ss`, role: 'solo', windowStartMs: 1_000 }],
    }));
    const deps = baseDeps(rows);
    const merge = deps.mergeWorkItemPayload;
    let writes = 0;
    deps.mergeWorkItemPayload = vi.fn(async (id, patch, opts) => {
      if (Object.hasOwn(patch, 'pilotArm') && ++writes === 2) throw new Error('injected second-row failure');
      return merge(id, patch, opts);
    });

    const result = await materializePilotCohort(
      { seed: 'seed', candidates, probeItemId: 'WI-PROBE', confirm: true },
      deps,
    );

    expect(result).toMatchObject({ ok: false, committed: false, applied: ['WI-1'], rolledBack: ['WI-1'] });
    expect(rows.get('WI-1')?.payload).not.toHaveProperty('pilotArm');
  });
});

describe('pilot cohort collection', () => {
  it('builds observations only from independent complete grades and fully priced participant windows', async () => {
    const ids = ['WI-A', 'WI-B', 'WI-C'];
    const seed = 'collect-seed';
    const assignment = assignCohort(
      ids.map((id) => ({ id, tier: 'substantive' })),
      seed,
    );
    const armById = new Map(assignment.assignments.map((row) => [row.id, row]));
    const rows = new Map<string, WorkItem>();
    for (const id of ids) {
      const assigned = armById.get(id)!;
      const participants =
        assigned.arm === 'C'
          ? [
              { ownerId: `${id}-d`, sessionId: `${id}-ds`, role: 'director', windowStartMs: 1_000 },
              { ownerId: `${id}-i`, sessionId: `${id}-is`, role: 'implementer', windowStartMs: 1_000 },
            ]
          : [{ ownerId: `${id}-s`, sessionId: `${id}-ss`, role: 'solo', windowStartMs: 1_000 }];
      rows.set(
        id,
        item(id, {
          state: 'done',
          closedAt: new Date(10_000).toISOString(),
          completionAuthority: 'committed',
          payload: {
            pilotArm: assigned.arm,
            pilotSeed: seed,
            pilotStratum: assigned.stratum,
            pilotBlockIndex: assigned.blockIndex,
            pilotPartialBlock: assigned.partialBlock,
            pilotAssignedAtMs: 500,
            pilotParticipants: participants,
          },
        }),
      );
    }

    const scorecards = ids.map(
      (id, index) =>
        ({
          issueId: `SC-${id}`,
          createdAt: new Date(9_000).toISOString(),
          createdBy: `grader-${id}`,
          subject: { ref: id },
          rubricRef: 'directed-pair-pilot-item-quality',
          ratings: {},
          nKeys: 5,
          missingKeys: [],
          extraKeys: [],
          rubricResolved: true,
          synthesized: false,
          score10: 6 + index,
          linkedItems: [],
        }) as ScorecardRow,
    );
    const deps = baseDeps(rows);
    deps.listScorecards = vi.fn(async () => scorecards);
    deps.readUsageCosts = vi.fn(
      async (_workspaceId: string, windows: readonly UsageWindow[]) =>
        new Map<string, ParticipantCost>(
          windows.map((window): [string, ParticipantCost] => [
            window.key,
            { key: window.key, sampleCount: 1, unpricedCount: 0, costUsd: 0.25 } satisfies ParticipantCost,
          ]),
        ),
    );

    const result = await collectPilotCohort(
      { workspaceId: 'papercusp-workspace', itemIds: ids, harness: 'papercusp' },
      deps,
    );

    expect(result.complete).toBe(true);
    expect(result.observationCount).toBe(3);
    expect(result.assignmentVerification.ok).toBe(true);
    expect(result.report.arms.C.totalCostUsd).toBe(0.5);
  });

  it('reports a participant-authored grade as a gap instead of using it', async () => {
    const rows = new Map<string, WorkItem>();
    rows.set(
      'WI-1',
      item('WI-1', {
        state: 'done',
        closedAt: new Date(10_000).toISOString(),
        payload: {
          pilotArm: 'A',
          pilotSeed: 'seed',
          pilotStratum: 'default',
          pilotBlockIndex: 0,
          pilotPartialBlock: true,
          pilotAssignedAtMs: 500,
          pilotParticipants: [{ ownerId: 'participant', sessionId: 'session', role: 'solo', windowStartMs: 1_000 }],
        },
      }),
    );
    const deps = baseDeps(rows);
    deps.listScorecards = vi.fn(async () => [
      {
        issueId: 'SC-1',
        createdAt: new Date(9_000).toISOString(),
        createdBy: 'participant',
        subject: { ref: 'WI-1' },
        rubricRef: 'directed-pair-pilot-item-quality',
        ratings: {},
        nKeys: 5,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 8,
        linkedItems: [],
      } as ScorecardRow,
    ]);

    const result = await collectPilotCohort({ workspaceId: 'papercusp-workspace', itemIds: ['WI-1'] }, deps);

    expect(result.complete).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({ itemId: 'WI-1', code: 'non-independent-scorecard' }));
    expect(result.observationCount).toBe(0);
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
