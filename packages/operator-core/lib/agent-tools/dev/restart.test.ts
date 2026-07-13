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
// EI-11137: the systemd truth-check that decides genuine-vs-phantom coalesce.
vi.mock('./systemd-service-probe', () => ({ probeServiceStart: vi.fn() }));

import { tryAcquireResource, tryReleaseResource } from '../locks/su-lock-store';
import { guardResource } from '../locks/resource-lock-guard';
import { spawn } from 'node:child_process';
import { probeServiceStart } from './systemd-service-probe';

const acquireM = vi.mocked(tryAcquireResource);
const releaseM = vi.mocked(tryReleaseResource);
const guardM = vi.mocked(guardResource);
const spawnM = vi.mocked(spawn);
const probeM = vi.mocked(probeServiceStart);

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
  // Benign default: no live main process to report. Individual tests that care
  // about the coalesce-truth check or the restartedFromPid surfacing override it.
  probeM.mockResolvedValue({ ok: true, mainPid: 0 } as never);
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
    // EI-11137: the pre-restart MainPID is captured so the caller can verify a real cycle.
    probeM.mockResolvedValue({ ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(acquireM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'staging-server-cooldown', mode: 'exclusive', ttlSec: 120 }),
    );
    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: true, drained: true, restartedFromPid: 4242 });
    expect(b.verifyWith).toMatch(/MainPID/);
    expect(b).not.toHaveProperty('phantomCoalesceBroken');
    expect(spawnM).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('papercup-staging-api.service')], expect.anything());
    // Left to expire, not released — the debounce depends on this.
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('coalesces when the marker is held AND systemd confirms a genuine recent restart — no drain, no restart, no spawn', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-1', owner_label: 'peer-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    // EI-11137: the service really did restart 12s ago (< 120s window) — genuine coalesce.
    probeM.mockResolvedValue({ ok: true, mainPid: 555, secondsSinceStart: 12 } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: false, coalesced: true, verified: true, restartedSecondsAgo: 12, mainPid: 555 });
    expect(b.note).toMatch(/peer-one/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('EI-11137: PHANTOM coalesce — marker held but systemd shows NO recent restart ⇒ refuses to coalesce and fires a real restart', async () => {
    // The reported wedge: a bg-host marker is held, but the service last started
    // long ago (older than the cooldown). Must NOT coalesce — must restart.
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'stale-peer', owner_label: 'stale-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    probeM.mockResolvedValue({ ok: true, mainPid: 909, secondsSinceStart: 6 * 3600 } as never); // 6h ago
    guardM.mockImplementation(runGuard(fenceOk(7)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 909 });
    expect(b.coalesced).toBeUndefined();
    expect(b.phantomCoalesceBroken).toMatchObject({ staleMarkerHolder: 'stale-one', serviceSecondsSinceStart: 6 * 3600, cooldownSec: 120 });
    expect(spawnM).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('papercup-bg-host.service')], expect.anything());
  });

  it('EI-11137: down service (MainPID 0) is NOT a recent restart ⇒ marker treated as phantom, restart fires', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'stale-peer', owner_label: 'stale-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    probeM.mockResolvedValue({ ok: true, mainPid: 0 } as never); // no live main process
    guardM.mockImplementation(runGuard(fenceOk(1)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true });
    expect(b.phantomCoalesceBroken).toMatchObject({ serviceSecondsSinceStart: null });
    expect(spawnM).toHaveBeenCalled();
  });

  it('EI-11137: unverifiable (probe failed) falls back to trusting the marker, flagged verified:false', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-1', owner_label: 'peer-one', mode: 'exclusive', status: 'held', reason: '', expires_ts: new Date() }],
    } as never);
    probeM.mockResolvedValue({ ok: false } as never); // no systemd / probe error

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: false, coalesced: true, verified: false });
    expect(b.note).toMatch(/could NOT be verified/i);
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
