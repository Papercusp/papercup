/**
 * list.test.ts — locks:list HANDLER domain-resolution behavior
 * (EI-18674647773291145 Defect 2). `readResourceQueue` / `getResource` /
 * `listResources` are mocked; this catches a regression where the tool
 * silently reports `holders: []` for a host-global resource (e.g.
 * 'release-deploy') because it only ever queried the caller's own
 * tree-scoped coordination domain instead of following the resource into
 * the fixed `hostGlobalLockDomain()` it actually acquires under — the exact
 * failure observed live (`locks:list { resource: 'release-deploy' }`
 * returning `holders: []` for a lock provably held elsewhere).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: '/caller/tree' })),
}));
vi.mock('./coordination-domain', () => ({
  hostGlobalLockDomain: vi.fn(() => 'papercusp-host-global'),
  HOST_GLOBAL_RESOURCES: new Set(['release-deploy']),
}));
vi.mock('./su-lock-store', () => ({
  getTxPool: vi.fn(() => ({})),
  getResource: vi.fn(),
  listResources: vi.fn(),
  readResourceQueue: vi.fn(),
}));

import { getResource, listResources, readResourceQueue } from './su-lock-store';
const getResourceM = vi.mocked(getResource);
const listResourcesM = vi.mocked(listResources);
const queueM = vi.mocked(readResourceQueue);

const tool = (await import('./list')).default;
type Out = { data: { ok: boolean; holders: unknown[]; draining: boolean } };
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;

const holder = (owner: string) => ({
  owner,
  owner_label: owner,
  mode: 'exclusive' as const,
  status: 'held' as const,
  reason: '',
  lock_id: owner,
  acquired_ts: new Date('2026-01-01T00:00:00Z'),
  expires_ts: new Date('2026-01-01T00:20:00Z'),
  fence_seq: 1,
});

beforeEach(() => vi.clearAllMocks());

describe('locks:list — host-global domain resolution (EI-18674647773291145)', () => {
  it('scoped to a host-global resource: queries hostGlobalLockDomain, NOT the caller domain', async () => {
    getResourceM.mockResolvedValue({ resource: 'release-deploy', description: '', rule_text: '', enforcement: 'enforced' } as never);
    queueM.mockResolvedValue({ holders: [holder('release-deploy:123:uuid')], draining: false });

    const b = await call({ resource: 'release-deploy' });

    expect(queueM).toHaveBeenCalledTimes(1);
    expect(queueM).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: 'papercusp-host-global',
      resource: 'release-deploy',
    });
    expect(b.data.holders).toHaveLength(1);
  });

  it('scoped to an ordinary (non-host-global) resource: queries only the caller domain', async () => {
    getResourceM.mockResolvedValue({ resource: 'dev-server', description: '', rule_text: '', enforcement: 'enforced' } as never);
    queueM.mockResolvedValue({ holders: [], draining: false });

    await call({ resource: 'dev-server' });

    expect(queueM).toHaveBeenCalledTimes(1);
    expect(queueM).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: '/caller/tree',
      resource: 'dev-server',
    });
  });

  it('unscoped listing merges BOTH the caller domain and the host-global domain, OR-ing draining', async () => {
    listResourcesM.mockResolvedValue([]);
    queueM
      .mockResolvedValueOnce({ holders: [holder('caller-owner')], draining: false })
      .mockResolvedValueOnce({ holders: [holder('release-deploy:999:uuid')], draining: true });

    const b = await call({});

    expect(queueM).toHaveBeenCalledTimes(2);
    expect(queueM).toHaveBeenNthCalledWith(1, expect.anything(), { coordinationDomain: '/caller/tree', resource: undefined });
    expect(queueM).toHaveBeenNthCalledWith(2, expect.anything(), { coordinationDomain: 'papercusp-host-global', resource: undefined });
    expect(b.data.holders).toHaveLength(2);
    expect(b.data.draining).toBe(true);
  });
});
