/**
 * join-group.test.ts — the plan_items:join_group HANDLER (resolvePlanScope/
 * joinWorkGroup + the name resolvers mocked). Pins that the handler resolves the plan
 * scope and the caller's adopted member name, then joins the work-group with the
 * resolved (workspace, harness, plan, ownerUser, memberName) tuple, returning the member
 * row. A regression that joins with the wrong identity tuple is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plan-items/join-group.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plans/source', () => ({ resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../../plan-items/agent-names', () => ({
  bestEffortOwnerUser: vi.fn(() => 'user-avi'),
  resolveAdoptedName: vi.fn(async () => 'Adopted Name'),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../plan-items/work-group', () => ({ joinWorkGroup: vi.fn() }));

import { joinWorkGroup } from '../../plan-items/work-group';
const joinM = vi.mocked(joinWorkGroup);
const tool = (await import('./join-group')).default;

type Out = { content: { text: string }[] };
const call = () => tool.handler({ plan: 'p1', harness: 'web' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('plan_items:join_group handler', () => {
  it('joins the work-group with the resolved scope + member identity and returns the member', async () => {
    joinM.mockResolvedValue({ plan: 'p1', user: 'user-avi', name: 'Adopted Name' } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, member: { plan: 'p1', user: 'user-avi', name: 'Adopted Name' } });
    expect(joinM).toHaveBeenCalledWith('default', 'web', 'p1', 'user-avi', 'Adopted Name');
  });
});
