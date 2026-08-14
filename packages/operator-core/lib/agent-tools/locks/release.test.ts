/**
 * release.test.ts — locks:release handler selected-list bulk support.
 *
 * Pins that selected lock releases use the shared bulk contract, including n=1.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/release.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRejectedTyped, mockResolvedOnceTyped, mockResolvedTyped } from '../../testing/typed-mock';
import type { ActiveLockRow } from './su-lock-store';

/** The release outcome release.ts decodes — see its `ReleaseOutcome`. */
type ReleaseOutcomeShape = { released: string[]; heldBefore: number | null };

// WI-38252: file locks resolve their default domain via readFileLockIdentity.
vi.mock('./identity', () => {
  const identity = vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' }));
  return { readIdentity: identity, readFileLockIdentity: identity };
});
vi.mock('./coordination-domain', () => ({ resolveExplicitFileLockDomain: vi.fn((requested: string | undefined, fallback: string) => requested ?? fallback) }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({
  tryRelease: vi.fn(),
  releaseAllResourcesForOwner: vi.fn(),
  // EI-20405390083792304 root fix: the cross-domain resolve reads the queue.
  readQueue: vi.fn(),
  getTxPool: vi.fn(() => ({})),
  ensureBootstrap: vi.fn(),
}));
vi.mock('./resource-broadcast', () => ({ broadcastResourceBackUp: vi.fn() }));
vi.mock('../../authority/file-lock-routing', () => ({ routeFileLockOp: vi.fn() }));
vi.mock('../../authority/file-lock-authority-ops', () => ({
  FILE_LOCK_OP_KINDS: { release: 'release' },
  // Real (not stubbed) fan-out so WI-1550 coverage below can assert on the
  // resulting recordLockEvent calls, not just that some mock fired.
  emitReleaseLockEvents: vi.fn((emit: (e: unknown) => void, p: { scope: string; owner: string; released: string[]; ts: number; publishedSha?: string | null }) => {
    for (const path of p.released) {
      emit({ kind: 'release', scope: p.scope, path, owner: p.owner, ts: p.ts, ...(p.publishedSha ? { publishedSha: p.publishedSha } : {}) });
    }
  }),
}));
vi.mock('../../authority/lock-event-stream', () => ({ recordLockEvent: vi.fn() }));

import { routeFileLockOp } from '../../authority/file-lock-routing';
import { recordLockEvent } from '../../authority/lock-event-stream';
import { releaseAllResourcesForOwner, readQueue } from './su-lock-store';
import { resolveExplicitFileLockDomain } from './coordination-domain';

const routeM = vi.mocked(routeFileLockOp);
const releaseResourcesM = vi.mocked(releaseAllResourcesForOwner);
const readQueueM = vi.mocked(readQueue);
const recordEventM = vi.mocked(recordLockEvent);
const resolveDomainM = vi.mocked(resolveExplicitFileLockDomain);
const tool = (await import('./release')).default;

type Out = { data?: any; content?: Array<{ text: string }> };
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => (o.data ?? JSON.parse(o.content![0].text));

beforeEach(() => {
  vi.clearAllMocks();
  routeM.mockImplementation(async (_domain, op) => ({
    value: { released: [`released:${(op.remote?.payload as { lockId?: string } | undefined)?.lockId ?? 'all'}`] },
  }) as never);
  releaseResourcesM.mockResolvedValue({ released: 0, exclusiveResources: [], waiters: {} } as never);
  mockResolvedTyped(readQueueM, { active_locks: [], waiting: [] });
});

/**
 * EI-20405390083792304 — the ROOT fix. A file lock's coordination domain is the
 * physical repo root of the EDITED file, which the PreToolUse hook sends
 * explicitly; an agent's own bare `locks:release` resolves
 * `<workspace_root>/papercusp` instead. When those differ the release matched
 * zero rows and still answered `ok:true, released:[]` — indistinguishable from
 * "you held nothing" — so the holder believed it was clear while the lock sat
 * until TTL and peers stayed blocked (proven live 2026-08-14).
 */
describe('locks:release cross-domain fallback (EI-20405390083792304)', () => {
  const LOCK = '33333333-3333-3333-3333-333333333333';
  // Opaque domain strings. Deliberately NOT a real home path: a hardcoded
  // /home/<user>/… in shipped source reds the identity-lint gate leg.
  const HIVE = '/hives/sidestage';

  type ReleaseRoute = { value: ReleaseOutcomeShape; via: string; scope?: string };
  /**
   * `routeFileLockOp` is generic in its op's return type, so vi.mocked() cannot
   * infer a concrete impl signature. ONE assertion at this seam keeps every call
   * site below fully typed — rather than an `as never` per fixture, which is what
   * the lint:mock-cast-escape ratchet exists to prevent.
   */
  const routeByDomain = (byDomain: (domain: string) => ReleaseRoute): void => {
    routeM.mockImplementation(
      ((domain: string) => Promise.resolve(byDomain(domain))) as unknown as typeof routeFileLockOp,
    );
  };

  /** A COMPLETE ActiveLockRow, so a new required column fails here at compile time. */
  const activeLock = (lockId: string, domain: string): ActiveLockRow => ({
    lock_id: lockId,
    path: 'f.ts',
    owner: 'me',
    owner_label: 'Me',
    intent: 'test',
    acquired_ts: new Date(0),
    expires_ts: new Date(Date.now() + 60_000),
    coordination_domain: domain,
  });

  const heldIn = (...rows: ActiveLockRow[]): void => {
    mockResolvedTyped(readQueueM, { active_locks: rows, waiting: [] });
  };

  /** Frees nothing in `dom` (the caller's domain), everything in `HIVE`. */
  const onlyHiveHolds = (paths: string[]) => {
    routeByDomain((domain) => domain === HIVE
      ? { value: { released: paths, heldBefore: paths.length }, via: 'local-authority' }
      : { value: { released: [], heldBefore: 0 }, via: 'local-authority' });
  };

  it('releases a lock held in another domain instead of silently no-opping', async () => {
    onlyHiveHolds(['app.module.ts']);
    heldIn(activeLock(LOCK, HIVE));

    const b = body(await call({ lock_id: LOCK }));
    expect(b.results[0].released).toEqual(['app.module.ts']);
    expect(b.results[0].cross_domain_released).toEqual([
      { coordination_domain: HIVE, released: ['app.module.ts'] },
    ]);
    // It must route to the domain that actually holds the lock, not the caller's.
    expect(routeM.mock.calls.map((c) => c[0])).toEqual(['dom', HIVE]);
  });

  it('does NOT pay for the cross-domain read when the caller\'s own domain frees the lock', async () => {
    // The hot path must stay exactly as cheap as before the fix.
    await call({ lock_id: LOCK });
    expect(readQueueM).not.toHaveBeenCalled();
    expect(routeM).toHaveBeenCalledTimes(1);
  });

  it('all_mine sweeps every domain the owner holds locks in', async () => {
    const OTHER = '/hives/other';
    routeByDomain((domain) => domain === 'dom'
      ? { value: { released: [], heldBefore: 0 }, via: 'local-authority' }
      : { value: { released: [`${domain}/f.ts`], heldBefore: 1 }, via: 'local-authority' });
    heldIn(activeLock('a', HIVE), activeLock('b', OTHER), activeLock('c', HIVE));

    const b = body(await call({ all_mine: true }));
    expect(b.released).toEqual([`${HIVE}/f.ts`, `${OTHER}/f.ts`]);
    // Each domain visited once, deduped.
    expect(routeM.mock.calls.map((c) => c[0])).toEqual(['dom', HIVE, OTHER]);
  });

  it('reports an honest empty release when the owner holds nothing anywhere', async () => {
    routeByDomain(() => ({ value: { released: [], heldBefore: 0 }, via: 'local-authority' }));
    const b = body(await call({ all_mine: true }));
    expect(b.released).toEqual([]);
    expect(b.held_before).toBe(0);
    expect(b.cross_domain_released).toBeUndefined();
  });

  it('never fails the caller\'s release because the cross-domain lookup faulted', async () => {
    routeByDomain(() => ({ value: { released: [], heldBefore: 0 }, via: 'local-authority' }));
    mockRejectedTyped(readQueueM, new Error('pool exhausted'));
    const b = body(await call({ all_mine: true }));
    expect(b.ok).toBe(true);
    expect(b.released).toEqual([]);
  });

  it('keeps an unknown heldBefore unknown rather than laundering it into a number', async () => {
    // A peer authority that does not report the count must not be summed into 0.
    routeByDomain((domain) => domain === HIVE
      ? { value: { released: ['x.ts'], heldBefore: null }, via: 'local-authority' }
      : { value: { released: [], heldBefore: 0 }, via: 'local-authority' });
    heldIn(activeLock(LOCK, HIVE));
    const b = body(await call({ lock_id: LOCK }));
    expect(b.results[0].held_before).toBeNull();
  });
});

describe('locks:release handler', () => {
  it('opts out of the ambient workspace transaction because the handler owns its DB scopes', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('wraps a single lock_id release through the keyed bulk envelope (n=1)', async () => {
    const b = body(await call({ lock_id: '11111111-1111-1111-1111-111111111111' }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, lock_id: '11111111-1111-1111-1111-111111111111', released: ['released:11111111-1111-1111-1111-111111111111'] },
      ],
    });
  });

  it('uses the domain carried by the matching edit-hook acquire', async () => {
    await call({ lock_id: '11111111-1111-1111-1111-111111111111', coordination_domain: '/canonical/staging' });
    expect(resolveDomainM).toHaveBeenCalledWith('/canonical/staging', 'dom');
    expect(routeM.mock.calls[0]?.[0]).toBe('/canonical/staging');
  });

  it('releases selected lock_ids as a keyed bulk envelope', async () => {
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
        { ok: true, lock_id: '11111111-1111-1111-1111-111111111111', released: ['released:11111111-1111-1111-1111-111111111111'] },
        { ok: true, lock_id: '22222222-2222-2222-2222-222222222222', released: ['released:22222222-2222-2222-2222-222222222222'] },
      ],
    });
  });

  it('rejects combining all_mine with selected lock ids', async () => {
    const b = body(await call({ all_mine: true, lock_ids: ['11111111-1111-1111-1111-111111111111'] }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/either all_mine=true or selected/);
  });

  it('rejects paths without a lock selector before touching the store', async () => {
    const b = body(await call({ paths: ['src/a.ts'] }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/requires lock_id or all_mine=true/);
    expect(String(b.error)).toMatch(/paths is only a filter/);
    expect(routeM).not.toHaveBeenCalled();
  });

  it('retries a transient workspace contention before returning the release result', async () => {
    vi.useFakeTimers();
    try {
      const contended = { name: 'WorkspaceContendedError', pgCode: '55P03' };
      routeM.mockRejectedValueOnce(contended);
      mockResolvedOnceTyped(routeM, {
        value: { ok: true, released: ['a.ts'] },
        via: 'local-authority',
        scope: 'harness-x',
      });

      const pending = call({ lock_id: '11111111-1111-1111-1111-111111111111' });
      await vi.runAllTimersAsync();
      const b = body(await pending);

      expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
      expect(routeM).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the local fallback when routing fails and the release transaction is transiently contended', async () => {
    vi.useFakeTimers();
    try {
      const contended = { name: 'WorkspaceContendedError', pgCode: '57014' };
      routeM.mockRejectedValue(new Error('authority route unavailable'));
      const tryReleaseM = vi.mocked((await import('./su-lock-store')).tryRelease);
      tryReleaseM.mockRejectedValueOnce(contended);
      mockResolvedTyped(tryReleaseM, { released: ['a.ts'] });

      const pending = call({ lock_id: '11111111-1111-1111-1111-111111111111' });
      await vi.runAllTimersAsync();
      const b = body(await pending);

      expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
      expect(tryReleaseM).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('locks:release — WI-1550 P-015 lock-event emission on a LOCALLY-decided release', () => {
  it('emits a lock-event when the release was decided local-authority with a resolved scope', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'local-authority', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).toHaveBeenCalledTimes(1);
    expect(recordEventM).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'release', scope: 'harness-x', path: 'a.ts', owner: 'me' }),
    );
  });

  it('emits on a fail-open release too (a remote authority was unreachable)', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'fail-open', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit locally when the release was relayed to a remote authority (it already recorded its own)', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'remote-authority', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('does NOT emit when the domain is unmanaged (no federated scope to record against)', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'local-authority' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('does NOT emit when nothing was actually released', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: [] }, via: 'local-authority', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('carries published_sha onto the release event', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'local-authority', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111', published_sha: 'a'.repeat(40) });
    expect(recordEventM).toHaveBeenCalledWith(expect.objectContaining({ publishedSha: 'a'.repeat(40) }));
  });
});
