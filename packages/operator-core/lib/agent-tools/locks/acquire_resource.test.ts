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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('./identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: Sql) => Promise<unknown>) => fn({} as Sql)),
}));
vi.mock('./su-lock-store', () => ({ tryAcquireResource: vi.fn() }));
vi.mock('./resource-acquire-wait', () => ({ acquireResourceExclusiveWithWait: vi.fn() }));
vi.mock('./ended-session-owners', () => ({ endedSessionOwners: vi.fn() }));
vi.mock('./resource-broadcast', () => ({ broadcastResourceDrainStart: vi.fn() }));
// WI-562584: the fail-closed cross-domain guard runs before either acquire
// branch. Its own rules are covered in cross-domain-conflict.test.ts; here it
// is mocked so these cases exercise the handler's branch/status mapping, and
// so a guard that silently stopped running would still be caught below.
vi.mock('./cross-domain-conflict', () => ({
  findCrossDomainResourceConflicts: vi.fn(async () => []),
  CROSS_DOMAIN_CONFLICT_HINT: 'HINT',
}));

import { tryAcquireResource, type ResourceAcquireResult } from './su-lock-store';
import { acquireResourceExclusiveWithWait } from './resource-acquire-wait';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { endedSessionOwners } from './ended-session-owners';
import { findCrossDomainResourceConflicts } from './cross-domain-conflict';
import { inWorkspaceTxn } from './in-workspace-txn';
const sharedM = vi.mocked(tryAcquireResource);
const exclM = vi.mocked(acquireResourceExclusiveWithWait);
const endedOwnersM = vi.mocked(endedSessionOwners);
const crossM = vi.mocked(findCrossDomainResourceConflicts);
const txnM = vi.mocked(inWorkspaceTxn);
const tool = (await import('./acquire_resource')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const callShared = () => tool.handler({ resource: 'dev-server', mode: 'shared' } as never, {} as never) as Promise<Out>;
const callExcl = () => tool.handler({ resource: 'dev-server', mode: 'exclusive', wait: { max_drain_sec: 5 } } as never, {} as never) as Promise<Out>;
const holder = { owner: 'o2', owner_label: 'O2', mode: 'shared', status: 'held', reason: '', expires_ts: new Date('2026-01-01T00:00:00Z') };
/** A COMPLETE granted-shared store result (no `as never`), so a new required
 *  field on ResourceAcquireResult fails here rather than at the fleet gate. */
const sharedGrant = (over: Partial<Extract<ResourceAcquireResult, { ok: true }>> = {}): ResourceAcquireResult => ({
  ok: true,
  lock_id: 'L1',
  mode: 'shared',
  status: 'held',
  expires_ts: new Date('2026-02-01T00:00:00Z'),
  shared_holders: [],
  fence_seq: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks preserves implementations. Reset the transaction/store
  // seams so the exhaustion cases cannot leak a persistent rejection into the
  // following recovery or cross-domain cases.
  txnM.mockReset();
  txnM.mockImplementation(async (_d: string, _o: string, fn: (tx: Sql) => Promise<unknown>) => fn({} as Sql));
  sharedM.mockReset();
  exclM.mockReset();
  endedOwnersM.mockReset();
  crossM.mockReset();
  crossM.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

const contention = (pgCode: '57014' | '55P03') =>
  Object.assign(new Error('workspace contended'), { name: 'WorkspaceContendedError', pgCode });

describe('locks:acquire_resource shared', () => {
  it('grants a shared hold', async () => {
    sharedM.mockResolvedValue(sharedGrant());
    const b = body(await callShared());
    expect(b).toMatchObject({ ok: true, lock_id: 'L1', mode: 'shared', status: 'held', owner: 'me' });
  });

  it('reports a conflict with the holder list projected', async () => {
    sharedM.mockResolvedValue({ ok: false, reason: 'held_exclusive', holders: [holder] } as never);
    const b = body(await callShared());
    expect(b).toMatchObject({ ok: false, reason: 'held_exclusive' });
    expect(b.holders[0]).toMatchObject({ owner: 'o2', mode: 'shared', expires_ts: '2026-01-01T00:00:00.000Z' });
  });

  it('maps transient workspace contention to an explicit retryable result', async () => {
    vi.useFakeTimers();
    txnM.mockRejectedValue(contention('57014'));
    const result = callShared();
    await vi.runAllTimersAsync();
    const b = body(await result);
    expect(b).toMatchObject({
      ok: false,
      reason: 'workspace_contended',
      transient: true,
      retryable: true,
      holder: 'unknown',
      holders: [],
      pg_code: '57014',
    });
    expect(String(b.advice)).toMatch(/retry/i);
    expect(String(b.advice)).toMatch(/unknown/i);
    expect(txnM).toHaveBeenCalledTimes(4);
  });

  it('retries a transient workspace contention and succeeds on a fresh transaction', async () => {
    vi.useFakeTimers();
    txnM.mockRejectedValueOnce(contention('57014'));
    sharedM.mockResolvedValue(sharedGrant());
    const result = callShared();
    await vi.runAllTimersAsync();
    const b = body(await result);
    expect(b).toMatchObject({ ok: true, lock_id: 'L1', mode: 'shared', status: 'held' });
    expect(txnM).toHaveBeenCalledTimes(2);
    expect(sharedM).toHaveBeenCalledTimes(1);
  });
});

describe('locks:acquire_resource exclusive', () => {
  it('held carries the fence_seq + waited_sec', async () => {
    exclM.mockResolvedValue({ ok: true, status: 'held', lock_id: 'L2', waited_sec: 3, fence_seq: 7 } as never);
    const b = body(await callExcl());
    expect(b).toMatchObject({ ok: true, status: 'held', mode: 'exclusive', fence_seq: 7, waited_sec: 3 });
  });

  it('forwards exclusive drain ticks to ctx.progress so the MCP idle clock stays alive', async () => {
    const progress = vi.fn();
    exclM.mockImplementation(async (params) => {
      params.onTick?.({ waited_sec: 2, holders: [] });
      return { ok: true, status: 'held', lock_id: 'L2', waited_sec: 2, shared_holders: [], fence_seq: 7 } as never;
    });

    const b = body(
      await tool.handler(
        { resource: 'dev-server', mode: 'exclusive', wait: { max_drain_sec: 5 } } as never,
        { progress } as never,
      ),
    );

    expect(b).toMatchObject({ ok: true, status: 'held', mode: 'exclusive', fence_seq: 7 });
    expect(progress).toHaveBeenCalledWith(
      undefined,
      JSON.stringify({
        phase: 'draining',
        elapsed_sec: 2,
        max_drain_sec: 5,
        remaining_sec: 3,
        holders: [],
      }),
    );
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

  it('maps transient workspace contention from the exclusive wait to an explicit retryable result', async () => {
    vi.useFakeTimers();
    exclM.mockRejectedValue(contention('55P03'));
    const result = callExcl();
    await vi.runAllTimersAsync();
    const b = body(await result);
    expect(b).toMatchObject({
      ok: false,
      reason: 'workspace_contended',
      transient: true,
      retryable: true,
      holder: 'unknown',
      holders: [],
      pg_code: '55P03',
    });
    expect(String(b.advice)).toMatch(/retry/i);
    expect(exclM).toHaveBeenCalledTimes(4);
  });

  it('retries a transient exclusive contention and succeeds on a fresh wait attempt', async () => {
    vi.useFakeTimers();
    exclM.mockRejectedValueOnce(contention('55P03'));
    exclM.mockResolvedValue({ ok: true, status: 'held', lock_id: 'L2', waited_sec: 0, fence_seq: 8 } as never);
    const result = callExcl();
    await vi.runAllTimersAsync();
    const b = body(await result);
    expect(b).toMatchObject({ ok: true, status: 'held', mode: 'exclusive', fence_seq: 8 });
    expect(exclM).toHaveBeenCalledTimes(2);
  });

  it('wires the ended-session oracle into the exclusive wait protocol', async () => {
    mockResolvedTyped(exclM, { ok: false, reason: 'held_exclusive', holders: [] });

    await callExcl();

    expect(exclM).toHaveBeenCalledWith(
      expect.objectContaining({ deadOwnerOracle: endedSessionOwners }),
    );
  });
});

// WI-562584 — the guard fails CLOSED: a wrong domain inference used to grant a
// lock over a live hold in a sibling coordination domain, so `ok:true` was not
// proof of exclusivity. These assert the handler REFUSES BEFORE the store is
// touched; the conflict rules themselves live in cross-domain-conflict.test.ts.
describe('locks:acquire_resource cross-domain guard', () => {
  const foreign = {
    coordination_domain: 'papercusp-workspace',
    resource: 'dev-server',
    owner: 'system:git-sync',
    owner_label: 'git-sync',
    mode: 'exclusive' as const,
    status: 'held',
    reason: 'sweep',
    acquired_ts: '2026-08-28T20:00:00.000Z',
    expires_ts: '2026-08-28T21:00:00.000Z',
  };

  it('refuses a shared acquire held in another domain, WITHOUT calling the store', async () => {
    crossM.mockResolvedValue([foreign]);
    const b = body(await callShared());
    expect(b).toMatchObject({ ok: false, reason: 'held_in_other_domain' });
    expect(b.holders[0]).toMatchObject({ owner: 'system:git-sync', coordination_domain: 'papercusp-workspace' });
    expect(sharedM).not.toHaveBeenCalled();
  });

  it('refuses an exclusive acquire held in another domain, WITHOUT starting a drain', async () => {
    crossM.mockResolvedValue([foreign]);
    const b = body(await callExcl());
    expect(b).toMatchObject({ ok: false, reason: 'held_in_other_domain' });
    expect(exclM).not.toHaveBeenCalled();
  });

  it('refuses fail-CLOSED when the sibling-domain read itself fails (an unanswered question is not permission)', async () => {
    crossM.mockRejectedValue(new Error('connection terminated'));
    const b = body(await callExcl());
    expect(b).toMatchObject({ ok: false, reason: 'cross_domain_check_failed', error: 'connection terminated' });
    expect(exclM).not.toHaveBeenCalled();
  });

  it('does NOT refuse when no sibling domain holds it — the ordinary path is unchanged', async () => {
    crossM.mockResolvedValue([]);
    sharedM.mockResolvedValue(sharedGrant());
    const b = body(await callShared());
    expect(b).toMatchObject({ ok: true, lock_id: 'L1' });
    expect(sharedM).toHaveBeenCalledTimes(1);
  });

  it('checks the domain the acquire actually TARGETS, not the caller-tree domain', async () => {
    crossM.mockResolvedValue([]);
    sharedM.mockResolvedValue(sharedGrant());
    await callShared();
    // 'dev-server' is host-global (HOST_GLOBAL_RESOURCES), so the target domain
    // is NOT readIdentity's 'dom' — passing the caller's domain here would make
    // the guard read the wrong sibling set and miss the real holder.
    expect(crossM).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'dev-server', requestedMode: 'shared', owner: 'me' }),
    );
    expect(crossM.mock.calls[0]![0].targetDomain).not.toBe('dom');
  });
});
