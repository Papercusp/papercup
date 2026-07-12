/**
 * dev:restart — target dispatch (dev/staging) + the WI-4221 staging
 * debounce/coalescing logic. `guardResource` (the drain+restart primitive)
 * is mocked — it already has its own coverage via
 * locks/__tests__/resource-lock-guard.integration.test.ts; this file's job
 * is the NEW behavior layered on top: target→{unit,resource} dispatch, the
 * cooldown-marker acquire-before-drain short-circuit, and releasing the
 * cooldown marker when a real restart attempt aborts after claiming it.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/restart.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../locks/in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('../locks/su-lock-store', () => ({
  tryAcquireResource: vi.fn(),
  tryReleaseResource: vi.fn(async () => ({ released: 1, releasedModes: ['exclusive'], exclusiveResources: [], waiters: {} })),
}));
vi.mock('../locks/resource-lock-guard', () => ({ guardResource: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

import { tryAcquireResource, tryReleaseResource } from '../locks/su-lock-store';
import { guardResource } from '../locks/resource-lock-guard';
import { spawn } from 'node:child_process';

const acquireM = vi.mocked(tryAcquireResource);
const releaseM = vi.mocked(tryReleaseResource);
const guardM = vi.mocked(guardResource);
const spawnM = vi.mocked(spawn);

const tool = (await import('./restart')).default;

type Out = { content: { text: string }[] };
type Fence = { assertCurrent: () => Promise<{ current: boolean; reason?: string; live_fence_seq?: number }>; seq?: number };
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
/** Drive guardResource's mock as `(spec, run) => run(fence)` — a thin,
 *  explicitly-typed stand-in for the real drain+fence primitive (which has
 *  its own coverage elsewhere) so `run` never infers to `never` through the
 *  generic mock. */
const runGuard = (fence: Fence) => async (_spec: unknown, run: (f: Fence) => Promise<unknown>) => ({
  acquired: true,
  result: await run(fence),
  lock_id: 'L-test',
});
const fenceOk = (seq = 1): Fence => ({ assertCurrent: async () => ({ current: true }), seq });
const fenceStale = (seq = 1): Fence => ({ assertCurrent: async () => ({ current: false, reason: 'superseded', live_fence_seq: 2 }), seq });

const ORIGINAL_ENV = process.env.PAPERCUSP_ALLOW_DEV_RESTART;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_ALLOW_DEV_RESTART;
  releaseM.mockResolvedValue({ released: 1, releasedModes: ['exclusive'], exclusiveResources: [], waiters: {} } as never);
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_ALLOW_DEV_RESTART;
  else process.env.PAPERCUSP_ALLOW_DEV_RESTART = ORIGINAL_ENV;
});

describe('dev:restart dry run', () => {
  it('defaults target to dev and reports the dev unit', async () => {
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: true, dry_run: true, target: 'dev', would_run: 'systemctl --user restart papercup-dev-api.service' });
    expect(b.note).not.toMatch(/coalesced/);
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('target:staging reports the staging unit + mentions the coalescing window', async () => {
    const b = body(await call({ target: 'staging' }));
    expect(b).toMatchObject({ ok: true, dry_run: true, target: 'staging', would_run: 'systemctl --user restart papercup-staging-api.service' });
    expect(b.note).toMatch(/coalesced/);
  });

  it('takes no lock and drains nobody on a dry run', async () => {
    await call({ target: 'staging' });
    expect(acquireM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART unset', () => {
  it('target:dev drains but withholds the restart, without touching the cooldown marker', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: true, target: 'dev', drained: true, restarted: false });
    // dev has no cooldownResource — the debounce path must never engage for it.
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('target:staging withholds the restart too, and never claims the cooldown marker (nothing real happened to debounce)', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'staging' }));
    expect(b).toMatchObject({ ok: true, target: 'staging', drained: true, restarted: false });
    expect(acquireM).not.toHaveBeenCalled();
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:staging', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('claims the cooldown marker, drains+restarts, and does NOT release the cooldown on success', async () => {
    acquireM.mockResolvedValue({ ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL1', expires_ts: new Date(), shared_holders: [], fence_seq: 1 } as never);
    guardM.mockImplementation(runGuard(fenceOk(9)) as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(acquireM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'staging-server-cooldown', mode: 'exclusive', ttlSec: 120 }),
    );
    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: true, drained: true });
    expect(spawnM).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('papercup-staging-api.service')], expect.anything());
    // Left to expire, not released — the debounce depends on this.
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('coalesces when the cooldown marker is already held by a peer — no drain, no restart, no spawn', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-1', owner_label: 'peer-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: false, coalesced: true });
    expect(b.note).toMatch(/peer-one/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('releases the cooldown marker if the drain/restart step aborts after claiming it (stale fence)', async () => {
    acquireM.mockResolvedValue({ ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL2', expires_ts: new Date(), shared_holders: [], fence_seq: 1 } as never);
    guardM.mockImplementation(runGuard(fenceStale()) as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: false, target: 'staging', reason: 'stale_fence_superseded' });
    expect(releaseM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lockId: 'COOL2' }));
  });

  it('releases the cooldown marker if the drain-gate itself never grants (e.g. drain_timeout)', async () => {
    acquireM.mockResolvedValue({ ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL3', expires_ts: new Date(), shared_holders: [], fence_seq: 1 } as never);
    guardM.mockResolvedValue({ acquired: false, reason: 'drain_timeout', holders: [] } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: false, target: 'staging', reason: 'resource_drain_timeout', resource: 'staging-server' });
    expect(releaseM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lockId: 'COOL3' }));
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:dev (unaffected by the debounce)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('never touches the cooldown machinery for dev', async () => {
    guardM.mockImplementation(runGuard(fenceOk(3)) as never);
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true });
    expect(acquireM).not.toHaveBeenCalled();
    expect(releaseM).not.toHaveBeenCalled();
    expect(spawnM).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('papercup-dev-api.service')], expect.anything());
  });
});
