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

import { normalizePaths, tryInsertWaiter } from './su-lock-store';
import { WorkspaceContendedError } from './in-workspace-txn';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import { recordLockEvent } from '../../authority/lock-event-stream';
const normM = vi.mocked(normalizePaths);
const insertM = vi.mocked(tryInsertWaiter);
const routeM = vi.mocked(routeFileLockOp);
const recordEventM = vi.mocked(recordLockEvent);
const tool = (await import('./acquire')).default;

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

  it('fast-path busy with no wait/wake → busy()', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] } } as never);
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] });
  });

  it('a WorkspaceContendedError degrades to a structured TRANSIENT workspace_contended (never a false holder, never a raw PG leak) — EI-9478', async () => {
    routeM.mockRejectedValue(new WorkspaceContendedError('ws', '55P03', new Error('advisory lock timeout')));
    const b = body(await call({}));
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
