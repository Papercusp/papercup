/** P-016: plan-item push assignment respects the target member's fleet scope. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const admission = vi.hoisted(() => ({ decision: { allowed: true, scoped: false } as any, notify: vi.fn() }));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-sender', workspaceId: 'ws-1' }),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'ws-1', harnessSlug: 'papercusp' })),
}));
vi.mock('../../plan-items/agent-names', () => ({
  bestEffortOwnerUser: vi.fn(() => 'avi'),
  agentNameOwner: vi.fn(async () => 'avi'),
  registerAgentName: vi.fn(),
}));
vi.mock('../../plan-items/assignments', () => ({
  assignItem: vi.fn(async (x) => x),
  planItemEffectiveStatus: vi.fn(async () => null),
}));
vi.mock('../plans/set-status', () => ({
  isTerminalStatus: (s: string) => s === 'done' || s === 'dropped',
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitSubjectForFleetTarget: vi.fn(async () => admission.decision),
  notifyFleetScopeRefusal: admission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
}));

import { assignItem, planItemEffectiveStatus } from '../../plan-items/assignments';
const assignM = vi.mocked(assignItem);
const statusM = vi.mocked(planItemEffectiveStatus);
const tool = (await import('./assign')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  admission.decision = { allowed: true, scoped: false };
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
});
