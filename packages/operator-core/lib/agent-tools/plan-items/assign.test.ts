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
vi.mock('../../plan-items/assignments', () => ({ assignItem: vi.fn(async (x) => x) }));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitSubjectForFleetTarget: vi.fn(async () => admission.decision),
  notifyFleetScopeRefusal: admission.notify,
}));

import { assignItem } from '../../plan-items/assignments';
const assignM = vi.mocked(assignItem);
const tool = (await import('./assign')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  admission.decision = { allowed: true, scoped: false };
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
  });
});
