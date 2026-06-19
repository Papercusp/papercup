/**
 * acquire_resource.test.ts — the locks:acquire_resource HANDLER branch + status mapping
 * (the store ops tryAcquireResource / acquireResourceExclusiveWithWait are mocked; the
 * txn wrapper just runs the callback). This is the named-resource drain protocol the
 * fleet uses to coordinate destructive shared actions, so its result mapping is
 * load-bearing:
 *   • shared → ok with lock_id, or conflict with the holder list;
 *   • exclusive → held (carries the fence_seq), draining (max_wait 0), drain_timeout, or
 *     conflict — each shaped distinctly with holders projected (expires_ts → ISO).
 * A regression that drops the fence token, or mis-maps a drain_timeout to ok, is what
 * this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/acquire_resource.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({ tryAcquireResource: vi.fn() }));
vi.mock('./resource-acquire-wait', () => ({ acquireResourceExclusiveWithWait: vi.fn() }));
vi.mock('./resource-broadcast', () => ({ broadcastResourceDrainStart: vi.fn() }));

import { tryAcquireResource } from './su-lock-store';
import { acquireResourceExclusiveWithWait } from './resource-acquire-wait';
const sharedM = vi.mocked(tryAcquireResource);
const exclM = vi.mocked(acquireResourceExclusiveWithWait);
const tool = (await import('./acquire_resource')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const callShared = () => tool.handler({ resource: 'dev-server', mode: 'shared' } as never, {} as never) as Promise<Out>;
const callExcl = () => tool.handler({ resource: 'dev-server', mode: 'exclusive', wait: { max_drain_sec: 5 } } as never, {} as never) as Promise<Out>;
const holder = { owner: 'o2', owner_label: 'O2', mode: 'shared', status: 'held', reason: '', expires_ts: new Date('2026-01-01T00:00:00Z') };

beforeEach(() => vi.clearAllMocks());

describe('locks:acquire_resource shared', () => {
  it('grants a shared hold', async () => {
    sharedM.mockResolvedValue({ ok: true, lock_id: 'L1', status: 'held', expires_ts: new Date('2026-02-01T00:00:00Z') } as never);
    const b = body(await callShared());
    expect(b).toMatchObject({ ok: true, lock_id: 'L1', mode: 'shared', status: 'held', owner: 'me' });
  });

  it('reports a conflict with the holder list projected', async () => {
    sharedM.mockResolvedValue({ ok: false, reason: 'held_exclusive', holders: [holder] } as never);
    const b = body(await callShared());
    expect(b).toMatchObject({ ok: false, reason: 'held_exclusive' });
    expect(b.holders[0]).toMatchObject({ owner: 'o2', mode: 'shared', expires_ts: '2026-01-01T00:00:00.000Z' });
  });
});

describe('locks:acquire_resource exclusive', () => {
  it('held carries the fence_seq + waited_sec', async () => {
    exclM.mockResolvedValue({ ok: true, status: 'held', lock_id: 'L2', waited_sec: 3, fence_seq: 7 } as never);
    const b = body(await callExcl());
    expect(b).toMatchObject({ ok: true, status: 'held', mode: 'exclusive', fence_seq: 7, waited_sec: 3 });
  });

  it('draining returns the current holders', async () => {
    exclM.mockResolvedValue({ ok: true, status: 'draining', lock_id: 'L2', holders: [holder] } as never);
    const b = body(await callExcl());
    expect(b).toMatchObject({ ok: true, status: 'draining' });
    expect(b.holders).toHaveLength(1);
  });

  it('drain_timeout is a failure carrying waited_sec + holders', async () => {
    exclM.mockResolvedValue({ ok: false, reason: 'drain_timeout', lock_id: 'L2', waited_sec: 300, holders: [holder] } as never);
    const b = body(await callExcl());
    expect(b).toMatchObject({ ok: false, reason: 'drain_timeout', waited_sec: 300 });
  });

  it('a plain conflict maps reason + holders (tolerating absent holders)', async () => {
    exclM.mockResolvedValue({ ok: false, reason: 'unknown_resource' } as never);
    const b = body(await callExcl());
    expect(b).toMatchObject({ ok: false, reason: 'unknown_resource', holders: [] });
  });
});
