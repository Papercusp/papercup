/**
 * record_replica_result.test.ts — the work_items:record_replica_result HANDLER
 * (recordReplicaResult, the owner-checked slot write, is mocked). Pins the handler's
 * own logic: the owner defaults to the caller, the distilled {text, meta} is passed
 * through to the store, a falsy result (already-recorded / stolen / never-claimed) maps
 * to a clear error, and a success projects the slot fields. A regression that drops the
 * owner default or the not-held error message is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/record_replica_result.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../work-item-redundancy', () => ({
  recordReplicaResult: vi.fn(),
  resolveReplicaHiveSlug: vi.fn(async () => 'hive-x'),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));

import { recordReplicaResult } from '../../work-item-redundancy';
const recordM = vi.mocked(recordReplicaResult);
const tool = (await import('./record_replica_result')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ id: 'F-1', harness: 'web', replicaIndex: 0, text: 'my distilled result', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('work_items:record_replica_result handler', () => {
  it('maps a falsy result (slot not held / already recorded / stolen) to an error', async () => {
    recordM.mockResolvedValue(null as never);
    const b = body(await call());
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/no claimed replica slot/i);
  });

  it('defaults owner to the caller and passes the distilled result through', async () => {
    recordM.mockResolvedValue({ workItemId: 'F-1', replicaIndex: 0, status: 'complete', redundancy: 2 } as never);
    const b = body(await call({ meta: { k: 1 } }));
    expect(b).toMatchObject({ ok: true, replica: { workItemId: 'F-1', replicaIndex: 0, status: 'complete', redundancy: 2 } });
    const arg = recordM.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.owner).toBe('me'); // defaulted to caller
    expect(arg.result).toMatchObject({ text: 'my distilled result', meta: { k: 1 } });
  });

  it('honors an explicit owner override', async () => {
    recordM.mockResolvedValue({ workItemId: 'F-1', replicaIndex: 1, status: 'complete', redundancy: 2 } as never);
    await call({ owner: 'other-swarm', replicaIndex: 1 });
    expect((recordM.mock.calls[0]![0] as Record<string, unknown>).owner).toBe('other-swarm');
  });
});
