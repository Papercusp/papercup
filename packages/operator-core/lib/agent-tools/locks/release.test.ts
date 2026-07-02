/**
 * release.test.ts — locks:release handler selected-list bulk support.
 *
 * Pins that selected lock releases use the shared bulk contract, including n=1.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/release.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })) }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({
  tryRelease: vi.fn(),
  releaseAllResourcesForOwner: vi.fn(),
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
import { releaseAllResourcesForOwner } from './su-lock-store';

const routeM = vi.mocked(routeFileLockOp);
const releaseResourcesM = vi.mocked(releaseAllResourcesForOwner);
const recordEventM = vi.mocked(recordLockEvent);
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
});

describe('locks:release handler', () => {
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
