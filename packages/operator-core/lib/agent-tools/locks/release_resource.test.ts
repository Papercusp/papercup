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

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

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

  it('releases a shared hold and does NOT broadcast (nothing exclusive freed)', async () => {
    releaseM.mockResolvedValue({ released: ['L1'], releasedModes: ['shared'], exclusiveResources: [], waiters: {} } as never);
    const b = body(await call({ lock_id: '11111111-1111-1111-1111-111111111111' }));
    expect(b).toMatchObject({ ok: true, released: ['L1'], released_modes: ['shared'], exclusive_resources: [] });
    expect(backUpM).not.toHaveBeenCalled();
  });

  it('broadcasts "back up" to waiters when an exclusive resource is freed', async () => {
    releaseM.mockResolvedValue({
      released: ['L2'], releasedModes: ['exclusive'], exclusiveResources: ['dev-server'], waiters: { 'dev-server': ['w1'] },
    } as never);
    const b = body(await call({ resource: 'dev-server' }));
    expect(b).toMatchObject({ ok: true, exclusive_resources: ['dev-server'] });
    expect(backUpM).toHaveBeenCalledTimes(1);
    expect(backUpM.mock.calls[0]![0]).toMatchObject({ resource: 'dev-server', waiters: ['w1'] });
  });
});
