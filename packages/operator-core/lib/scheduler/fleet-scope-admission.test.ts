/** Recurrence guards for P-016's shared fleet-scope predicate + wind-down contract. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterNode } from './claim-spec';
import {
  claimSpecSubjectFromWorkItem,
  matchesClaimSpecFilter,
  type ClaimSpecSubject,
} from './claim-spec-match';
const admissionMocks = vi.hoisted(() => ({
  getClaimSpecRecord: vi.fn(),
  latestFleetMembership: vi.fn(),
  listFleetAssignments: vi.fn(),
  getWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('./claim-spec-store', () => ({
  getClaimSpecRecord: admissionMocks.getClaimSpecRecord,
}));
vi.mock('../fleet-membership-store', () => ({
  latestFleetMembership: admissionMocks.latestFleetMembership,
}));
vi.mock('../fleet/assignments', () => ({
  listFleetAssignments: admissionMocks.listFleetAssignments,
}));
vi.mock('../work-items', () => ({
  getWorkItem: admissionMocks.getWorkItem,
  releaseWorkItem: admissionMocks.releaseWorkItem,
}));
vi.mock('../agent-tools/coordination/messages', () => ({
  sendMessage: admissionMocks.sendMessage,
}));

import { fleetScopedMiss, reconcileFleetScopeClaims } from './fleet-scope-admission';

const base: ClaimSpecSubject = {
  id: 'WI-7',
  title: 'Fix scheduler admission',
  kind: 'bug',
  priority: 3,
  tags: ['scheduler', 'non-p2p'],
  paths: ['packages/operator-core/lib/scheduler/get-next.ts'],
  plan: 'bug-drain',
  planItem: ['P-016'],
  age: 1_000,
  riskTier: 'moderate',
  redundancy: 1,
  estCost: 12,
  assignee: null,
};

describe('fleet scope assignment admission (P-016)', () => {
  beforeEach(() => {
    for (const mock of Object.values(admissionMocks)) mock.mockReset();
    admissionMocks.sendMessage.mockResolvedValue(undefined);
  });

  it('evaluates the full boolean grammar, including id cohort + non-P2P exclusion', () => {
    const filter: FilterNode = {
      all: [
        { field: 'id', op: 'in', value: ['WI-7', 'WI-8'] },
        { field: 'kind', op: '=', value: 'bug' },
        { not: { field: 'title', op: 'glob', value: '*p2p*' } },
        { any: [{ field: 'tags', op: 'contains', value: 'scheduler' }, { field: 'risk_tier', op: '=', value: 'low' }] },
      ],
    };
    expect(matchesClaimSpecFilter(base, filter)).toBe(true);
    expect(matchesClaimSpecFilter({ ...base, id: 'WI-out' }, filter)).toBe(false);
    expect(matchesClaimSpecFilter({ ...base, title: 'P2P transport bug' }, filter)).toBe(false);
  });

  it('treats an unknown not-yet-minted id as outside a fixed cohort', () => {
    expect(matchesClaimSpecFilter({ ...base, id: null }, { field: 'id', op: 'in', value: ['WI-7'] })).toBe(false);
  });

  it('mirrors priority inversion and array membership semantics from the SQL compiler', () => {
    expect(matchesClaimSpecFilter(base, { field: 'priority', op: '>', value: 5 })).toBe(true);
    expect(matchesClaimSpecFilter(base, { field: 'plan_item', op: '=', value: 'P-016' })).toBe(true);
    expect(matchesClaimSpecFilter(base, { field: 'paths', op: 'glob', value: '*scheduler*' })).toBe(true);
  });

  it('hydrates issue plan/risk/path vocabulary from the canonical payload shape', () => {
    const subject = claimSpecSubjectFromWorkItem({
      id: 'EI-9',
      harness: 'papercusp',
      kind: 'bug',
      family: 'issue',
      title: 'issue',
      summary: 'body',
      state: 'open',
      assignee: null,
      takenAt: null,
      lastProgressAt: null,
      assignedBy: null,
      severity: 'major',
      parent: null,
      payload: {
        plan_item: { plan_slug: 'ops', item_id: 'P-9' },
        paths: ['packages/operator-core/lib/x.ts'],
        risk_tier: 'high',
      },
      rank: null,
      rankWriter: null,
      rankUpdatedAt: null,
      priority: null,
      origin: 'local',
      auditVerdict: null,
      verifiedAuthorGithubUserId: null,
      terminalOwner: null,
      terminalCompletionRef: null,
      terminalCompletionEvidence: null,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    });
    expect(subject).toMatchObject({ plan: 'ops', planItem: ['P-9'], riskTier: 'high' });
    expect(subject.paths).toEqual(['packages/operator-core/lib/x.ts']);
  });

  it('returns an explicit wind-down verdict instead of generic-backlog advice', () => {
    const miss = fleetScopedMiss({
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: {
        source: 'fleet',
        spec: { specVersion: '1.0', specId: 'bugs-rev4', revision: 4, view: {}, rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] } },
        revision: 4,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    }, ['WI-out']);
    expect(miss).toMatchObject({ windDown: true, quarantinedIds: ['WI-out'], fleetScope: { fleet: 'bugs' } });
    expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    expect(miss.advice).toMatch(/loop:end/);
  });

  it('releases every incompatible pre-existing claim in one reconciliation sweep and alerts once', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'bugs', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({
      source: 'fleet',
      spec: {
        specVersion: '1.0',
        specId: 'bugs-rev4',
        revision: 4,
        view: { filter: { field: 'id', op: 'in', value: ['WI-in'] } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 4,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    });
    admissionMocks.listFleetAssignments.mockResolvedValue([
      { source: 'work_item_claim', workItemId: 'WI-out-1' },
      { source: 'work_item_claim', workItemId: 'WI-in' },
      { source: 'work_item_claim', workItemId: 'WI-out-2' },
      { source: 'work_item_claim', workItemId: 'WI-out-1' }, // de-duped, not dripped into a later wake
    ]);
    admissionMocks.getWorkItem.mockImplementation(async (id: string) => ({
      id,
      family: 'issue',
      kind: 'bug',
      title: id,
      summary: id,
      state: 'wip',
      assignee: 'su-member',
      payload: {},
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    }));
    admissionMocks.releaseWorkItem.mockImplementation(async (id: string) => ({ id }));

    const result = await reconcileFleetScopeClaims({
      ownerId: 'su-member',
      workspaceId: 'papercusp-workspace',
      identity: { ownerId: 'su-member' } as never,
    });

    expect(result.quarantinedIds).toEqual(['WI-out-1', 'WI-out-2']);
    expect(admissionMocks.releaseWorkItem).toHaveBeenCalledTimes(2);
    expect(admissionMocks.releaseWorkItem).toHaveBeenNthCalledWith(1, 'WI-out-1', {
      expectedAssignee: 'su-member',
    });
    expect(admissionMocks.releaseWorkItem).toHaveBeenNthCalledWith(2, 'WI-out-2', {
      expectedAssignee: 'su-member',
    });
    expect(admissionMocks.sendMessage).toHaveBeenCalledOnce();
    expect(admissionMocks.sendMessage.mock.calls[0]?.[1]).toMatchObject({
      to: ['@fleet-leader:bugs'],
      summary: 'quarantined 2 out-of-scope fleet claim(s)',
    });
  });
});
