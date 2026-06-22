/**
 * release_resource.test.ts — the locks:release_resource HANDLER (tryReleaseResource +
 * broadcastResourceBackUp mocked; txn wrapper runs the callback). Pins: the required-arg
 * guard (lock_id OR resource), the result projection, and — the load-bearing part — that
 * a "back up" broadcast fires ONLY when an EXCLUSIVE resource was actually freed (and to
 * its waiters, not the whole fleet). A regression that broadcasts on every release, or
 * lets a no-arg call hit the store, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/release_resource.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' })) }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({ tryReleaseResource: vi.fn() }));
vi.mock('./resource-broadcast', () => ({ broadcastResourceBackUp: vi.fn() }));

import { tryReleaseResource } from './su-lock-store';
import { broadcastResourceBackUp } from './resource-broadcast';
const releaseM = vi.mocked(tryReleaseResource);
const backUpM = vi.mocked(broadcastResourceBackUp);
const tool = (await import('./release_resource')).default;

type Out = { data: any };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => (o.data);

beforeEach(() => {
  vi.clearAllMocks();
  backUpM.mockResolvedValue(undefined as never);
});

describe('locks:release_resource handler', () => {
  it('requires lock_id or resource — refuses without touching the store', async () => {
    const b = body(await call());
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/lock_id or resource/);
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('wraps a single lock_id release through the keyed bulk envelope and does NOT broadcast for shared holds', async () => {
    releaseM.mockResolvedValue({ released: ['L1'], releasedModes: ['shared'], exclusiveResources: [], waiters: {} } as never);
    const b = body(await call({ lock_id: '11111111-1111-1111-1111-111111111111' }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, lock_id: '11111111-1111-1111-1111-111111111111', released: ['L1'], released_modes: ['shared'], exclusive_resources: [] },
      ],
    });
    expect(backUpM).not.toHaveBeenCalled();
  });

  it('wraps a single resource release through the keyed bulk envelope and broadcasts when exclusive', async () => {
    releaseM.mockResolvedValue({
      released: ['L2'], releasedModes: ['exclusive'], exclusiveResources: ['dev-server'], waiters: { 'dev-server': ['w1'] },
    } as never);
    const b = body(await call({ resource: 'dev-server' }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, resource: 'dev-server', released: ['L2'], released_modes: ['exclusive'], exclusive_resources: ['dev-server'] },
      ],
    });
    expect(backUpM).toHaveBeenCalledTimes(1);
    expect(backUpM.mock.calls[0]![0]).toMatchObject({ resource: 'dev-server', waiters: ['w1'] });
  });

  it('releases selected resource lock_ids as a keyed bulk envelope', async () => {
    releaseM.mockImplementation(async (_tx, spec) => ({
      released: [spec.lockId],
      releasedModes: ['shared'],
      exclusiveResources: [],
      waiters: {},
    }) as never);
    const b = body(await call({
      lock_ids: [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ],
    }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 2, failed: 0 },
      results: [
        { ok: true, lock_id: '11111111-1111-1111-1111-111111111111', released: ['11111111-1111-1111-1111-111111111111'], released_modes: ['shared'] },
        { ok: true, lock_id: '22222222-2222-2222-2222-222222222222', released: ['22222222-2222-2222-2222-222222222222'], released_modes: ['shared'] },
      ],
    });
  });

  it('releases selected resource names and broadcasts per exclusive resource', async () => {
    releaseM.mockImplementation(async (_tx, spec) => ({
      released: [spec.resource],
      releasedModes: ['exclusive'],
      exclusiveResources: [spec.resource],
      waiters: { [spec.resource as string]: [`waiter:${spec.resource}`] },
    }) as never);
    const b = body(await call({ resources: ['dev-server', 'db'] }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 2, failed: 0 },
      results: [
        { ok: true, resource: 'dev-server', exclusive_resources: ['dev-server'] },
        { ok: true, resource: 'db', exclusive_resources: ['db'] },
      ],
    });
    expect(backUpM).toHaveBeenCalledTimes(2);
    expect(backUpM.mock.calls[0]![0]).toMatchObject({ resource: 'dev-server', waiters: ['waiter:dev-server'] });
    expect(backUpM.mock.calls[1]![0]).toMatchObject({ resource: 'db', waiters: ['waiter:db'] });
  });
});
