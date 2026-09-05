/** P-016: plan-item push assignment respects the target member's fleet scope. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StableAgentTargetState } from '../coordination/actionable-work-item-dispatch';
import type { WorkItem } from '../../work-items';

const admission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  linkedDecision: { allowed: false, scoped: true } as any,
  notify: vi.fn(),
  findLinked: vi.fn(async (): Promise<WorkItem | null> => null),
}));

/** A complete WorkItem row for the linked-implementation lookup — typed, so the
 *  fixture is checked against the real shape instead of cast through `never`. */
const linkedWi = (id: string): WorkItem => ({
  id,
  state: 'open',
  kind: 'bug',
  family: 'issue',
  harness: 'papercusp',
  title: 't',
  summary: 's',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  parent: null,
  payload: null,
  origin: 'local',
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  goalId: null,
});
const agentNames = vi.hoisted(() => ({
  bestEffortOwnerUser: vi.fn(() => 'avi'),
  agentNameOwner: vi.fn(async () => 'avi' as string | null),
  registerAgentName: vi.fn(),
}));
const targetResolver = vi.hoisted(() => ({
  resolveStableAgentTarget: vi.fn(
    async ({ targetAgent }: { targetAgent: string }): Promise<StableAgentTargetState> => ({
      requested: targetAgent,
      ownerId: targetAgent,
      present: false,
      sessionState: null,
      wakeable: false,
    }),
  ),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-sender', workspaceId: 'ws-1' }),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'ws-1', harnessSlug: 'papercusp' })),
}));
vi.mock('../../plan-items/agent-names', () => agentNames);
vi.mock('../../plan-items/assignments', () => ({
  assignItem: vi.fn(async (x) => x),
  planItemEffectiveStatus: vi.fn(async () => null),
}));
vi.mock('../plans/set-status', () => ({
  isTerminalStatus: (s: string) => s === 'done' || s === 'dropped',
}));
vi.mock('../coordination/actionable-work-item-dispatch', () => targetResolver);
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitSubjectForFleetTarget: vi.fn(async () => admission.decision),
  admitWorkItemForFleetTarget: vi.fn(async () => admission.linkedDecision),
  notifyFleetScopeRefusal: admission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
}));
vi.mock('../../plan-items/convert', () => ({
  findImplementingWorkItem: admission.findLinked,
}));

import { assignItem, planItemEffectiveStatus } from '../../plan-items/assignments';
import { admitWorkItemForFleetTarget } from '../../scheduler/fleet-scope-admission';
import { findImplementingWorkItem } from '../../plan-items/convert';
const assignM = vi.mocked(assignItem);
const statusM = vi.mocked(planItemEffectiveStatus);
const ownerM = vi.mocked(agentNames.agentNameOwner);
const targetM = vi.mocked(targetResolver.resolveStableAgentTarget);
const linkedAdmissionM = vi.mocked(admitWorkItemForFleetTarget);
const findLinkedM = vi.mocked(findImplementingWorkItem);
const tool = (await import('./assign')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  admission.decision = { allowed: true, scoped: false };
  admission.linkedDecision = { allowed: false, scoped: true };
  admission.findLinked.mockResolvedValue(null);
  ownerM.mockResolvedValue('avi');
  targetM.mockImplementation(async ({ targetAgent }) => ({
    requested: targetAgent,
    ownerId: targetAgent,
    present: false,
    sessionState: null,
    wakeable: false,
  }));
  statusM.mockResolvedValue(null); // default: non-terminal → assignment proceeds
});

describe('plan_items:assign fleet admission', () => {
  it('keeps normal non-fleet assignment behavior', async () => {
    const b = await body({ plan: 'ops', item: 'P-001', assignee: 'builder' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(assignM).toHaveBeenCalledOnce();
  });

  it('refuses a plan item outside the member spec before assignment and alerts the leader', async () => {
    admission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'ops#P-001 is outside fleet scope',
      scope: { fleetSlug: 'bugs', ownerId: 'su-member', fleetRole: 'member', record: { spec: { specId: 'bugs', revision: 2 } } },
    };
    const b = await body({ plan: 'ops', item: 'P-001', assignee: 'builder' });
    expect(b.results[0]).toMatchObject({ ok: false, plan: 'ops', item: 'P-001' });
    expect(b.results[0].refused).toMatch(/fleet_scope_violation/);
    expect(assignM).not.toHaveBeenCalled();
    expect(admission.notify).toHaveBeenCalledOnce();
    // EI-18673501896258575: the caller sees the SAME concrete remedy the leader was
    // notified with, not just a bare refusal reason.
    expect(b.results[0].refused).toMatch(/remedy: scheduler:set_claim_spec/);
  });

  it('re-checks a linked execution work-item when the plan subject misses an exact-id member spec', async () => {
    admission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'plan subject is outside the exact-id fleet scope',
      scope: { fleetSlug: 'exact-id', ownerId: 'su-member', fleetRole: 'member', record: { spec: { specId: 'exact-id', revision: 3 } } },
    };
    admission.findLinked.mockResolvedValue(linkedWi('WI-2024456'));
    admission.linkedDecision = { allowed: true, scoped: true, scope: admission.decision.scope };

    const b = await body({ plan: 'ops', item: 'P-001', assignee: 'builder' });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(assignM).toHaveBeenCalledOnce();
    expect(findLinkedM).toHaveBeenCalledWith('ops', 'P-001');
    expect(linkedAdmissionM).toHaveBeenCalledWith({
      target: 'builder',
      workItemId: 'WI-2024456',
      harness: 'papercusp',
      workspaceId: 'ws-1',
    });
    expect(admission.notify).not.toHaveBeenCalled();
  });

  it('keeps the refusal when the linked work-item also fails by-id admission', async () => {
    admission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'plan subject is outside the fleet scope',
      scope: { fleetSlug: 'exact-id', ownerId: 'su-member', fleetRole: 'member', record: { spec: { specId: 'exact-id', revision: 3 } } },
    };
    admission.findLinked.mockResolvedValue(linkedWi('WI-out-of-scope'));
    admission.linkedDecision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'linked work-item is outside the exact-id fleet scope',
      scope: admission.decision.scope,
    };

    const b = await body({ plan: 'ops', item: 'P-001', assignee: 'builder' });

    expect(b.results[0]).toMatchObject({ ok: false, plan: 'ops', item: 'P-001' });
    expect(b.results[0].refused).toMatch(/fleet_scope_violation/);
    expect(findLinkedM).toHaveBeenCalledWith('ops', 'P-001');
    expect(linkedAdmissionM).toHaveBeenCalledWith({
      target: 'builder',
      workItemId: 'WI-out-of-scope',
      harness: 'papercusp',
      workspaceId: 'ws-1',
    });
    expect(admission.notify).toHaveBeenCalledOnce();
    expect(assignM).not.toHaveBeenCalled();
  });

  it('does not use the linked-work-item fallback for other refusal codes', async () => {
    admission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_missing',
      reason: 'member has no authored claim spec',
      scope: { fleetSlug: 'unconfigured', ownerId: 'su-member', fleetRole: 'member', record: { spec: { specId: 'unconfigured', revision: 1 } } },
    };
    admission.findLinked.mockResolvedValue(linkedWi('WI-2024456'));
    admission.linkedDecision = { allowed: true, scoped: true, scope: admission.decision.scope };

    const b = await body({ plan: 'ops', item: 'P-001', assignee: 'builder' });

    expect(b.results[0]).toMatchObject({ ok: false, plan: 'ops', item: 'P-001' });
    expect(b.results[0].refused).toMatch(/fleet_scope_missing/);
    expect(findLinkedM).not.toHaveBeenCalled();
    expect(linkedAdmissionM).not.toHaveBeenCalled();
    expect(assignM).not.toHaveBeenCalled();
  });

  // EI-2295 (push-assign leg): re-assigning an already-DONE/dropped item is a no-op
  // whose only effect is a stale wake — refuse it before the durable write.
  it('refuses (re)assigning an already-terminal plan item and never writes', async () => {
    statusM.mockResolvedValue('done');
    const b = await body({ plan: 'ops', item: 'P-001', assignee: 'builder' });
    expect(b.results[0]).toMatchObject({ ok: false, plan: 'ops', item: 'P-001' });
    expect(b.results[0].refused).toMatch(/already done \(terminal\)/);
    expect(assignM).not.toHaveBeenCalled();
  });

  it('still assigns when the item status is non-terminal (wip)', async () => {
    statusM.mockResolvedValue('wip');
    const b = await body({ plan: 'ops', item: 'P-002', assignee: 'builder' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(assignM).toHaveBeenCalledOnce();
  });

  it('refuses assigning to a confirmed-ended raw ownerId before writing', async () => {
    ownerM.mockResolvedValue(null);
    targetM.mockResolvedValue({
      requested: 'dead-owner',
      ownerId: 'dead-owner',
      present: true,
      sessionState: 'ended',
      wakeable: false,
    });

    const b = await body({ plan: 'ops', item: 'P-003', assignee: 'dead-owner' });

    expect(b.results[0]).toMatchObject({ ok: false, plan: 'ops', item: 'P-003' });
    expect(b.results[0].refused).toMatch(/ended session|sessionState=ended/);
    expect(assignM).not.toHaveBeenCalled();
  });

  it('refuses assigning to a foreign raw ownerId, while retaining pull-only semantics', async () => {
    ownerM.mockResolvedValue(null);
    targetM.mockResolvedValue({
      requested: 'foreign-owner',
      ownerId: 'foreign-owner',
      present: true,
      sessionState: 'live',
      wakeable: true,
      userId: 'other-user',
    });

    const b = await body({ plan: 'ops', item: 'P-004', assignee: 'foreign-owner' });

    expect(b.results[0]).toMatchObject({ ok: false, plan: 'ops', item: 'P-004' });
    expect(b.results[0].refused).toMatch(/another user|cross-user|pull-only/);
    expect(assignM).not.toHaveBeenCalled();
  });

  it('does not reject a fresh or unstarted stable name when no raw ownerId is present', async () => {
    ownerM.mockResolvedValue(null);
    targetM.mockResolvedValue({
      requested: 'new-builder',
      ownerId: 'new-builder',
      present: false,
      sessionState: null,
      wakeable: false,
    });

    const b = await body({ plan: 'ops', item: 'P-005', assignee: 'new-builder' });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(assignM).toHaveBeenCalledOnce();
  });
});
