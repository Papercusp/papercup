/**
 * acquire.test.ts — the locks:acquire HANDLER, the fleet's hot file-claim path. The
 * blocking WAIT loop (timers + the grant cascade) is integration-tier and not covered
 * here; this pins the unit-testable branches that decide the OUTCOME:
 *   • normalizePaths rejection → { ok:false, error } (no acquire attempted);
 *   • fast-path success → the ok() projection (lock_id, echoed owner, ISO expiry, held);
 *   • fast-path busy with no wait/wake → busy();
 *   • a WorkspaceContendedError from the routing layer → a structured empty busy (never a
 *     raw PG error leaked to the agent);
 *   • wake_on_grant: queued_for_wake (ticket + await registered), self_granted → ok, and
 *     a failed waiter insert → the reason.
 * Everything is mocked so the handler is isolated to its own control flow.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/acquire.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })) }));
vi.mock('./enrich-busy', () => ({ enrichBusy: vi.fn(async (b: unknown) => b) }));
vi.mock('./in-workspace-txn', () => {
  class WorkspaceContendedError extends Error {}
  return {
    WorkspaceContendedError,
    inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
  };
});
vi.mock('./su-lock-store', () => ({
  normalizePaths: vi.fn((p: string[]) => p),
  tryAcquire: vi.fn(),
  tryInsertWaiter: vi.fn(),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(),
  readWaiterStatus: vi.fn(),
  expireWaiter: vi.fn(),
  pokeWorkspace: vi.fn(),
}));
vi.mock('./workspace-listener', () => {
  class TooManyActiveWorkspacesError extends Error {}
  return { subscribeWorkspace: vi.fn(), TooManyActiveWorkspacesError };
});
vi.mock('./lock-grant-bridge', () => ({ ensureGrantListener: vi.fn(), lockGrantKey: vi.fn((t: string) => `grant:${t}`) }));
vi.mock('../../events/await/handle', () => ({ captureWakeHandleForOwner: vi.fn(async () => ({ handle: {}, note: 'wake-note' })) }));
vi.mock('../../events/await/store', () => ({ registerAwait: vi.fn(async () => ({ id: 'A1' })) }));
vi.mock('../../events/await/engine', () => ({ startAwaitSweeper: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'ws-1' })) }));
vi.mock('../../authority/file-lock-routing', () => ({ routeFileLockOp: vi.fn() }));
vi.mock('../../authority/file-lock-authority-ops', () => ({
  FILE_LOCK_OP_KINDS: { acquire: 'acquire' },
  // Real (not stubbed) fan-out so WI-1550 coverage below can assert on the
  // resulting recordLockEvent calls, not just that some mock fired.
  emitAcquireLockEvents: vi.fn((emit: (e: unknown) => void, p: { scope: string; owner: string; paths: string[]; expiresAtMs: number; ts: number }) => {
    for (const path of p.paths) emit({ kind: 'acquire', scope: p.scope, path, owner: p.owner, expiresAtMs: p.expiresAtMs, ts: p.ts });
  }),
}));
vi.mock('../../authority/lock-event-stream', () => ({ recordLockEvent: vi.fn() }));

import { normalizePaths, tryInsertWaiter, readWaiterStatus, pokeWorkspace, expireWaiter, tryAcquire } from './su-lock-store';
import { WorkspaceContendedError } from './in-workspace-txn';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import { recordLockEvent } from '../../authority/lock-event-stream';
const normM = vi.mocked(normalizePaths);
const insertM = vi.mocked(tryInsertWaiter);
const routeM = vi.mocked(routeFileLockOp);
const recordEventM = vi.mocked(recordLockEvent);
const statusM = vi.mocked(readWaiterStatus);
const pokeM = vi.mocked(pokeWorkspace);
const expireM = vi.mocked(expireWaiter);
const tryAcquireM = vi.mocked(tryAcquire);
const tool = (await import('./acquire')).default;

/** postgres-js's own shape for a connection drop mid-query (EI-19324204900062056). */
const connectionClosedError = () =>
  Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:6432'), { code: 'CONNECTION_CLOSED' });

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) =>
  tool.handler({ paths: ['a.ts'], intent: 'edit', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  normM.mockImplementation((p) => p);
});

describe('locks:acquire — outcome branches', () => {
  it('guidance describes managed Codex hook support plus explicit-lock fallback', () => {
    const guidance = `${tool.guidance?.when ?? ''}\n${tool.guidance?.notWhen ?? ''}`;
    expect(guidance).toMatch(/managed Codex\/Claude\/OMP homes hook apply_patch\/Edit\/Write/);
    expect(guidance).toMatch(/lacks lock hooks/);
    expect(guidance).not.toMatch(/automatic on every client/);
    expect(guidance).not.toMatch(/single incidental edit needs no manual call/);
  });

  it('rejects malformed paths before attempting acquire', async () => {
    normM.mockImplementation(() => { throw new Error('absolute path not allowed'); });
    const b = body(await call({ paths: ['/etc/x'] }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/absolute path/);
    expect(routeM).not.toHaveBeenCalled();
  });

  it('fast-path success → ok projection (echoes owner, ISO expiry, held)', async () => {
    routeM.mockResolvedValue({ value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] } } as never);
    const b = body(await call({}));
    expect(b).toMatchObject({
      ok: true, lock_id: 'L1', owner: 'me', owner_label: 'Me',
      expires_ts: '2026-02-01T00:00:00.000Z', held: ['a.ts'],
    });
  });

  it('maps absolute home configuration files to the hook-compatible reserved key', async () => {
    routeM.mockResolvedValue({
      value: {
        ok: true,
        lock_id: 'L-home',
        expires_ts: new Date('2026-02-01T00:00:00Z'),
        held: ['@external/home/.config/mimeapps.list'],
      },
    } as never);
    const out = await tool.handler({
      external_paths: [join(homedir(), '.config', 'mimeapps.list')],
      intent: 'edit desktop defaults',
    } as never, {} as never) as Out;
    expect(normM).toHaveBeenCalledWith(['@external/home/.config/mimeapps.list']);
    expect(body(out)).toMatchObject({ ok: true, lock_id: 'L-home' });
  });

  it('fast-path busy with no wait/wake → busy()', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } } as never);
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] });
  });

  it('a WorkspaceContendedError degrades to a structured TRANSIENT workspace_contended (never a false holder, never a raw PG leak) — EI-9478', async () => {
    // Mirrors the real WorkspaceContendedError shape (`.name` set) so this
    // exercises the EI-13189 contention-retry path (below) before degrading —
    // not just an immediate instanceof-check bypass.
    routeM.mockRejectedValue(
      Object.assign(new WorkspaceContendedError('ws', '55P03', new Error('advisory lock timeout')), {
        name: 'WorkspaceContendedError',
        pgCode: '55P03',
      }),
    );
    vi.useFakeTimers();
    try {
      const p = call({});
      await vi.runAllTimersAsync(); // advance both contention-retry backoff windows (routed + local-fallback)
      const b = body(await p);
      // EI-9478: an EXPLICIT transient reason with an EMPTY busy list — so no
      // downstream reader (esp. the edit hook) can render it as "held by another
      // agent" with a fabricated holder. The pre-fix code returned a bare busy:[],
      // which the hook then printed under a "file(s) held by another agent:" header
      // with zero holders.
      expect(b).toMatchObject({ ok: false, reason: 'workspace_contended', transient: true, busy: [] });
      // The advice steers to a plain RETRY and explicitly AWAY from wake_on_grant
      // (there is no holder to wait on).
      expect(String(b.advice)).toMatch(/retry/i);
      expect(String(b.advice)).toMatch(/do NOT queue wake_on_grant/i);
      // EI-13189: contention is retried (LOCK_CONTENTION_BACKOFFS_MS = 3 backoffs,
      // i.e. 4 attempts) before degrading to workspace_contended — not surfaced on
      // the very first timeout.
      expect(routeM.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('EI-13189: a TRANSIENT contention that clears on retry acquires normally (no user-visible failure)', async () => {
    let n = 0;
    routeM.mockImplementation(async () => {
      if (n++ < 1) {
        throw Object.assign(new Error('workspace contended'), { name: 'WorkspaceContendedError', pgCode: '55P03' });
      }
      // WI-5217: `as never` matches the established pattern for every other routeM
      // mock return in this file — RouteResult<T> requires a `via` field this test
      // fixture doesn't (need to) supply.
      return { value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] } } as never;
    });
    vi.useFakeTimers();
    try {
      const p = call({});
      await vi.runAllTimersAsync();
      const b = body(await p);
      expect(b).toMatchObject({ ok: true, lock_id: 'L1', held: ['a.ts'] });
      expect(routeM.mock.calls.length).toBe(2); // one transient miss, then a clean grant
    } finally {
      vi.useRealTimers();
    }
  });

  it('wake_on_grant queues a waiter + await and returns immediately', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } } as never);
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T1' } as never);
    const b = body(await call({ wake_on_grant: true }));
    expect(b).toMatchObject({ ok: false, queued_for_wake: true, ticket_id: 'T1', await_id: 'A1' });
  });

  it('wake_on_grant self-grant (path freed during insert) → ok', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [] } } as never);
    insertM.mockResolvedValue({ ok: true, self_granted: true, lock_id: 'L2', expires_ts: new Date('2026-03-01T00:00:00Z'), held: ['a.ts'] } as never);
    const b = body(await call({ wake_on_grant: true }));
    expect(b).toMatchObject({ ok: true, lock_id: 'L2', held: ['a.ts'] });
  });

  it('wake_on_grant with a failed waiter insert surfaces the reason', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [] } } as never);
    insertM.mockResolvedValue({ ok: false, reason: 'waiter_cap_exceeded' } as never);
    const b = body(await call({ wake_on_grant: true }));
    expect(b).toMatchObject({ ok: false, reason: 'waiter_cap_exceeded' });
  });
});

describe('locks:acquire — EI-19324204900062056 blocking-wait connection resilience', () => {
  // Contention path so the tool proceeds past the fast-path to the wait
  // subsystem (LISTEN + INSERT waiter + poll loop).
  beforeEach(() => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } } as never);
  });

  it('a transient CONNECTION_CLOSED error while polling status mid-wait is swallowed — the wait continues instead of crashing the call', async () => {
    // wait_until is far enough in the future that the loop is entered (and
    // the ceiling setTimeout below fires) at least once, but short enough
    // that a single real ~50ms tick carries it past waitUntilMs — avoids
    // fake-timer choreography of the internal ceiling Promise/setTimeout
    // while keeping the test's wall-clock cost negligible.
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-A', wait_until: new Date(Date.now() + 50) } as never);
    // Pre-loop immediate re-check: not yet granted, so the loop is entered.
    statusM.mockResolvedValueOnce({ status: 'waiting' } as never);
    // Inside the loop: poking the workspace hits the transient connection drop.
    pokeM.mockRejectedValueOnce(connectionClosedError());
    // Step 6 (after the loop exits on wait_until elapsing): both calls
    // succeed normally on the reconnected pool — proves the mid-loop error
    // didn't abort the call, it was swallowed and control reached here.
    expireM.mockResolvedValueOnce(undefined as never);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } as never);

    const b = body(await call({ wait: { max_sec: 1 } }));

    // A normal timeout/busy result — NOT a thrown error, NOT wait_connection_unstable.
    expect(b).toMatchObject({ ok: false, ticket_id: 'T-A', busy: [{ path: 'a.ts', owner: 'o2' }] });
    expect(b.reason).not.toBe('wait_connection_unstable');
    expect(pokeM).toHaveBeenCalled();
  });

  it('a transient CONNECTION_CLOSED error at the tail (step 6 expireWaiter) degrades to a structured wait_connection_unstable — never a raw thrown/MCP-fatal error', async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-B', wait_until: new Date(Date.now() - 1000) } as never); // already elapsed → 0 loop iterations
    statusM.mockResolvedValueOnce({ status: 'waiting' } as never);
    expireM.mockRejectedValueOnce(connectionClosedError());

    const b = body(await call({ wait: { max_sec: 1 } }));

    expect(b).toMatchObject({
      ok: false,
      reason: 'wait_connection_unstable',
      transient: true,
      ticket_id: 'T-B',
      busy: [],
    });
    expect(String(b.advice)).toMatch(/wake_on_grant/);
    // Never reached tryAcquire — expireWaiter's failure short-circuited to the degrade.
    expect(tryAcquireM).not.toHaveBeenCalled();
  });

  it('a NON-transient error mid-wait still propagates (this fix must not mask genuine bugs)', async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-C', wait_until: new Date(Date.now() + 50) } as never);
    statusM.mockResolvedValueOnce({ status: 'waiting' } as never);
    pokeM.mockRejectedValueOnce(new Error('boom: not a connection error'));

    await expect(call({ wait: { max_sec: 1 } })).rejects.toThrow('boom: not a connection error');
  });
});

describe('locks:acquire — EI-19382183884861720: the two gaps EI-19324204900062056 missed (INSERT + the immediate post-insert re-check)', () => {
  // Contention path so the tool proceeds past the fast-path to the wait
  // subsystem (LISTEN + INSERT waiter + poll loop) — same setup as the
  // EI-19324204900062056 suite above.
  beforeEach(() => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } } as never);
  });

  it('a transient CONNECTION_CLOSED error on the IMMEDIATE post-insert re-check is swallowed — falls through to the wait loop instead of crashing the call', async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-D', wait_until: new Date(Date.now() + 50) } as never);
    // Immediate post-insert re-check (BEFORE the step 4-5 loop): connection drop.
    statusM.mockRejectedValueOnce(connectionClosedError());
    // Inside the loop the connection has reconnected — resolves normally.
    pokeM.mockResolvedValue(undefined as never);
    statusM.mockResolvedValueOnce({ status: 'waiting' } as never);
    // Step 6 after the loop exits on wait_until elapsing.
    expireM.mockResolvedValueOnce(undefined as never);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } as never);

    const b = body(await call({ wait: { max_sec: 1 } }));

    // A normal timeout/busy result — NOT a thrown error, NOT wait_connection_unstable.
    expect(b).toMatchObject({ ok: false, ticket_id: 'T-D', busy: [{ path: 'a.ts', owner: 'o2' }] });
    expect(b.reason).not.toBe('wait_connection_unstable');
  });

  it('a NON-transient error on the immediate post-insert re-check still propagates (never masked)', async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-E', wait_until: new Date(Date.now() + 50) } as never);
    statusM.mockRejectedValueOnce(new Error('boom: not a connection error'));

    await expect(call({ wait: { max_sec: 1 } })).rejects.toThrow('boom: not a connection error');
  });

  it('a transient CONNECTION_CLOSED error on the waiter INSERT (step 3) is retried once and the call proceeds normally', async () => {
    insertM
      .mockRejectedValueOnce(connectionClosedError())
      .mockResolvedValueOnce({ ok: true, ticket_id: 'T-F', wait_until: new Date(Date.now() - 1000) } as never); // already elapsed → 0 loop iterations
    statusM.mockResolvedValueOnce({ status: 'waiting' } as never);
    expireM.mockResolvedValueOnce(undefined as never);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } as never);

    const b = body(await call({ wait: { max_sec: 1 } }));

    expect(b).toMatchObject({ ok: false, ticket_id: 'T-F' });
    expect(insertM).toHaveBeenCalledTimes(2);
  });

  it('a NON-transient error on the waiter INSERT propagates immediately, with no retry', async () => {
    insertM.mockRejectedValueOnce(new Error('boom: not a connection error'));

    await expect(call({ wait: { max_sec: 1 } })).rejects.toThrow('boom: not a connection error');
    expect(insertM).toHaveBeenCalledTimes(1);
  });
});

describe('locks:acquire — EI-9033 pending_edit (apply-on-grant) guardrails', () => {
  it('rejects pending_edit without wake_on_grant (it runs on the wake queue)', async () => {
    const b = body(await call({ pending_edit: { file: 'a.ts', old_string: 'X', new_string: 'Y' } }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/requires wake_on_grant/);
    expect(routeM).not.toHaveBeenCalled();
  });

  it('rejects pending_edit when paths is not exactly [pending_edit.file]', async () => {
    const b = body(
      await call({
        paths: ['a.ts', 'b.ts'],
        wake_on_grant: true,
        pending_edit: { file: 'a.ts', old_string: 'X', new_string: 'Y' },
      }),
    );
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/single-file only/);
    expect(routeM).not.toHaveBeenCalled();
  });

  it('threads a valid pending_edit into the waiter and flags apply_on_grant', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } } as never);
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T9' } as never);
    const b = body(
      await call({
        wake_on_grant: true,
        pending_edit: { file: 'a.ts', old_string: 'OLD', new_string: 'NEW' },
      }),
    );
    expect(b).toMatchObject({ ok: false, queued_for_wake: true, apply_on_grant: true, ticket_id: 'T9' });
    expect(insertM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pendingEdit: { file: 'a.ts', old_string: 'OLD', new_string: 'NEW' },
      }),
    );
  });
});

describe('locks:acquire — WI-1550 P-015 lock-event emission on a LOCALLY-decided grant', () => {
  it('emits a lock-event when the grant was decided local-authority with a resolved scope', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] },
      via: 'local-authority',
      scope: 'harness-x',
    } as never);
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: true, lock_id: 'L1' });
    expect(recordEventM).toHaveBeenCalledTimes(1);
    expect(recordEventM).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'acquire', scope: 'harness-x', path: 'a.ts', owner: 'me', expiresAtMs: Date.parse('2026-02-01T00:00:00Z') }),
    );
  });

  it('emits on a fail-open grant too (a remote authority was unreachable)', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] },
      via: 'fail-open',
      scope: 'harness-x',
      warning: 'authority unreachable',
    } as never);
    await call({});
    expect(recordEventM).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit locally when the grant was relayed to a remote authority (it already recorded its own)', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] },
      via: 'remote-authority',
      scope: 'harness-x',
    } as never);
    await call({});
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('does NOT emit when the domain is unmanaged (no federated scope to record against)', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] },
      via: 'local-authority',
      // scope omitted — unmanaged/unfederated domain
    } as never);
    await call({});
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('emits one event per held path on a multi-path grant', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts', 'b.ts'] },
      via: 'local-authority',
      scope: 'harness-x',
    } as never);
    await call({ paths: ['a.ts', 'b.ts'] });
    expect(recordEventM).toHaveBeenCalledTimes(2);
    expect(recordEventM.mock.calls.map((c) => (c[0] as { path: string }).path).sort()).toEqual(['a.ts', 'b.ts']);
  });
});
