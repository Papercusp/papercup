/**
 * leave-group.test.ts — the plan_items:leave_group HANDLER (resolvePlanScope/
 * leaveWorkGroup mocked). Pins that it resolves the plan scope + the caller's owner-user
 * and leaves the work-group with that exact (workspace, harness, plan, ownerUser) tuple,
 * returning the left record. A regression that leaves with the wrong identity tuple is
 * what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plan-items/leave-group.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plans/source', () => ({ resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../../plan-items/agent-names', () => ({ bestEffortOwnerUser: vi.fn(() => 'user-avi') }));
vi.mock('../../plan-items/work-group', () => ({ leaveWorkGroup: vi.fn() }));

import { leaveWorkGroup } from '../../plan-items/work-group';
const leaveM = vi.mocked(leaveWorkGroup);
const tool = (await import('./leave-group')).default;

// plan_items:leave_group returns the canonical `{ data }` shape (token-opt P-003,
// migrated 2026-08-25 / WI-41709). Pinned deliberately rather than accepting
// both shapes, so a revert to inline JSON fails here instead of passing quietly.
type Out = { data: Record<string, unknown> };
const body = (o: Out) => o.data;

beforeEach(() => vi.clearAllMocks());

describe('plan_items:leave_group handler', () => {
  it('leaves the work-group with the resolved scope + owner-user', async () => {
    leaveM.mockResolvedValue({ plan: 'p1', user: 'user-avi' } as never);
    const out = (await tool.handler({ plan: 'p1', harness: 'web' } as never, {} as never)) as Out;
    expect(leaveM).toHaveBeenCalledWith('default', 'web', 'p1', 'user-avi');
    expect(body(out)).toMatchObject({ ok: true, left: { plan: 'p1', user: 'user-avi' } });
  });
});
