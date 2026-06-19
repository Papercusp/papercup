/**
 * unassign.test.ts — the plan_items:unassign HANDLER (resolvePlanScope/unassignItem
 * mocked). Pins the scope resolution + the result branch: a real release returns
 * { ok:true, released }, while no active assignment returns { ok:true, released:null,
 * note } rather than an error (soft-release is idempotent). A regression that errors on
 * a no-op unassign is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plan-items/unassign.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plans/source', () => ({ resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../../plan-items/assignments', () => ({ unassignItem: vi.fn() }));

import { unassignItem } from '../../plan-items/assignments';
const unassignM = vi.mocked(unassignItem);
const tool = (await import('./unassign')).default;

type Out = { content: { text: string }[] };
const call = () => tool.handler({ plan: 'p1', item: 'P-001', harness: 'web' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('plan_items:unassign handler', () => {
  it('returns the released assignment when one existed', async () => {
    unassignM.mockResolvedValue({ assignee: 'bee-1' } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, released: { assignee: 'bee-1' } });
    expect(unassignM).toHaveBeenCalledWith('default', 'web', 'p1', 'P-001');
  });

  it('is a no-op (released:null + note) when there was no active assignment', async () => {
    unassignM.mockResolvedValue(null as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, released: null, note: 'no active assignment' });
  });
});
