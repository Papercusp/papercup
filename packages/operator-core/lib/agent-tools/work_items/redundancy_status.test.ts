/**
 * redundancy_status.test.ts — the work_items:redundancy_status HANDLER (the redundancy
 * store reads are mocked). Pins the not_found mapping and the COMPUTED fields the handler
 * derives: highStakes (redundancy > 1), active (the master switch), completeCount (count
 * of status==='complete'), judgeable (completeCount >= 2), and the per-replica projection
 * (extra columns dropped). A regression in the judgeable threshold or completeCount is
 * what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/redundancy_status.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-item-redundancy', () => ({
  getItemRedundancy: vi.fn(),
  listReplicas: vi.fn(),
  resolveReplicaHiveSlug: vi.fn(async () => 'hive-x'),
  workItemRedundancyEnabled: vi.fn(() => false),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));

import { getItemRedundancy, listReplicas, workItemRedundancyEnabled } from '../../work-item-redundancy';
const redM = vi.mocked(getItemRedundancy);
const listM = vi.mocked(listReplicas);
const activeM = vi.mocked(workItemRedundancyEnabled);
const tool = (await import('./redundancy_status')).default;

type Out = { content: { text: string }[] };
const call = () => tool.handler({ id: 'F-1', harness: 'web' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  activeM.mockReturnValue(false);
  listM.mockResolvedValue([] as never);
});

describe('work_items:redundancy_status handler', () => {
  it('maps a missing/non-redundant item to not found', async () => {
    redM.mockResolvedValue(null as never);
    const b = body(await call());
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/not found/i);
  });

  it('computes highStakes, completeCount, judgeable=true (>=2 complete)', async () => {
    redM.mockResolvedValue(3 as never);
    activeM.mockReturnValue(true);
    listM.mockResolvedValue([
      { replicaIndex: 0, owner: 'a', status: 'complete', expired: false, expiresTs: 't', judgeComposite: 0.8, judgeRationale: 'ok', extra: 'DROP' },
      { replicaIndex: 1, owner: 'b', status: 'complete', expired: false, expiresTs: 't' },
      { replicaIndex: 2, owner: 'c', status: 'claimed', expired: false, expiresTs: 't' },
    ] as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, redundancy: 3, highStakes: true, active: true, completeCount: 2, judgeable: true });
    expect(b.replicas).toHaveLength(3);
    expect(b.replicas[0]).not.toHaveProperty('extra'); // projected, not leaked
  });

  it('judgeable=false with only one complete replica; redundancy 1 is not high-stakes', async () => {
    redM.mockResolvedValue(1 as never);
    listM.mockResolvedValue([{ replicaIndex: 0, owner: 'a', status: 'complete' }, { replicaIndex: 1, owner: 'b', status: 'claimed' }] as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, highStakes: false, completeCount: 1, judgeable: false });
  });
});
