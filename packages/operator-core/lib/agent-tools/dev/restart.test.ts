/**
 * dev:restart — target dispatch (dev/staging) + the WI-4221 staging
 * debounce/coalescing logic. `guardResource` (the drain+restart primitive)
 * is mocked — it already has its own coverage via
 * locks/__tests__/resource-lock-guard.integration.test.ts; this file's job
 * is the NEW behavior layered on top: target→{unit,resource} dispatch, the
 * cooldown-marker and git-sync-barrier acquire-before-drain short-circuits,
 * and releasing those markers when a real restart attempt aborts after claiming
 * them.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/restart.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../locks/in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('../locks/su-lock-store', () => ({
  tryAcquireResource: vi.fn(),
  tryReleaseResource: vi.fn(async () => ({
    released: 1,
    releasedModes: ['exclusive'],
    exclusiveResources: [],
    waiters: {},
  })),
}));
vi.mock('../locks/resource-lock-guard', () => ({ guardResource: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(() => ({ unref: vi.fn() })) };
});
// EI-11137: the systemd truth-check that decides genuine-vs-phantom coalesce.
vi.mock('./systemd-service-probe', () => ({ probeServiceStart: vi.fn() }));
// EI-21651903020639415: gateway restarts must prove the new PID owns the
// listener before reporting restarted:true. Mock the shared HTTP probe so the
// regression suite stays hermetic and can assert the PID-before-health order.
vi.mock('../../escalating-http-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../escalating-http-probe')>();
  return { ...actual, probeHttpReachable: vi.fn() };
});
// EI-21651903020639415: gateway readiness must prove that the replacement
// MainPID owns the listener before probing /healthz. Keep the listener table
// hermetic here; its own parser/OS integration coverage lives in listening-sockets.
vi.mock('../../listening-sockets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../listening-sockets')>();
  return { ...actual, listListeningSockets: vi.fn() };
});
// EI-18661647550414959: the pre-kill "can this tree actually boot?" check. Mocked so
// the suite never shells out to systemctl; its own logic is covered in
// restart-preflight.test.ts. The default (set in beforeEach) is a clean tree.
vi.mock('./restart-preflight', () => ({ preflightRestartTarget: vi.fn() }));
vi.mock('./desktop-dev-restart', () => ({
  DESKTOP_DEV_RESOURCE: 'desktop-dev-server',
  resolveDesktopDevListener: vi.fn(),
  restartDesktopDev: vi.fn(),
}));
vi.mock('../../release/gate-collision-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../release/gate-collision-guard')>();
  return {
    ...actual,
    checkGateCollision: vi.fn(),
    checkGitSyncCollision: vi.fn(),
    acquireGitSyncRestartBarrier: vi.fn(),
  };
});
// WI-2140796: the bg-host quiesce preflight. isQuiesceSensitiveTarget stays real
// (spread importOriginal) so the dev/staging/etc. "never even probed" assertions
// below are meaningful; only the probing/judging call is mocked.
vi.mock('./bg-host-quiesce-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bg-host-quiesce-guard')>();
  return { ...actual, checkBgHostQuiesce: vi.fn() };
});
// EI-18198340374286980: the audit_log writer — asserted directly in the new
// authorize-arg tests below, and must never make a real restart fail if it
// throws (fire-and-forget), so every OTHER test gets a working no-op stub.
// Partial mock (importOriginal): @papercusp/agent-mcp's own bootstrap imports
// OTHER exports (e.g. `generated`) from this same package — a full replacement
// breaks that unrelated import chain.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: vi.fn() };
});

import { tryAcquireResource, tryReleaseResource } from '../locks/su-lock-store';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';
import { guardResource, type FenceToken, type GuardOutcome, type GuardSpec } from '../locks/resource-lock-guard';
import { spawn } from 'node:child_process';
import { probeServiceStart } from './systemd-service-probe';
import { probeHttpReachable } from '../../escalating-http-probe';
import { listListeningSockets } from '../../listening-sockets';
import { preflightRestartTarget } from './restart-preflight';
import { resolveDesktopDevListener, restartDesktopDev } from './desktop-dev-restart';
import { getOrgPg } from '@papercusp/db-org';
import { BUDGET, HARD_CAP, promptWeight } from '../tool-guidance-budget';
import {
  acquireGitSyncRestartBarrier,
  checkGateCollision,
  checkGitSyncCollision,
} from '../../release/gate-collision-guard';
import { checkBgHostQuiesce } from './bg-host-quiesce-guard';
import { mockImplementationTyped, mockResolvedOnceTyped, mockResolvedTyped } from '../../testing/typed-mock';
import type { StagingRestartReadiness } from './restart';

const acquireM = vi.mocked(tryAcquireResource);
const releaseM = vi.mocked(tryReleaseResource);
const workspaceTxnM = vi.mocked(inWorkspaceTxn);
const guardM = vi.mocked(guardResource);
const spawnM = vi.mocked(spawn);
const probeM = vi.mocked(probeServiceStart);
const gatewayHealthM = vi.mocked(probeHttpReachable);
const listeningSocketsM = vi.mocked(listListeningSockets);
const preflightM = vi.mocked(preflightRestartTarget);
const desktopResolveM = vi.mocked(resolveDesktopDevListener);
const desktopRestartM = vi.mocked(restartDesktopDev);
/** A boot-integrity verdict. Defaults to an inspected, clean tree. */
const bootVerdict = (over: Record<string, unknown> = {}) =>
  ({
    target: 'dev',
    unit: 'papercusp-dev-api.service',
    checked: true,
    ok: true,
    requestedRoot: '/tree/apps/operator',
    lockRoot: '/tree',
    missing: [],
    extraneous: [],
    note: 'clean',
    ...over,
  }) as never;
const orgPgM = vi.mocked(getOrgPg);
const auditUnsafeM = vi.fn(async (_query: string, _params: unknown[]) => undefined);
const gateCollisionM = vi.mocked(checkGateCollision);
const gitSyncCollisionM = vi.mocked(checkGitSyncCollision);
const gitSyncBarrierM = vi.mocked(acquireGitSyncRestartBarrier);
const gitSyncBarrierReleaseM = vi.fn(async () => undefined);
const quiesceM = vi.mocked(checkBgHostQuiesce);
/** A quiesce verdict. Defaults to "not quiesced" (see beforeEach). */
const quiesceVerdict = (over: Record<string, unknown> = {}) =>
  ({
    target: 'bg-host',
    quiesced: false,
    blocked: false,
    overridden: false,
    marker: null,
    probeFailed: false,
    note: 'bg-host is not quiesced.',
    ...over,
  }) as never;

const gatewayListenerResult = (pid: number) =>
  ({
    sockets: [
      {
        port: 8788,
        address: '127.0.0.1',
        family: 'ipv4',
        pid,
        pids: [pid],
        listeners: 1,
        command: 'gateway',
        ownerVisible: true,
        reserved: false,
        acceptQueue: { pending: 0, backlog: 511 },
        app: null,
        appUnknownReason: 'not-attempted',
        localUrl: `http://127.0.0.1:8788`,
      },
    ],
    matched: 1,
    totalListening: 1,
    truncated: false,
    ownerHidden: 0,
  }) satisfies Awaited<ReturnType<typeof listListeningSockets>>;

const clearGateCollision = () => ({
  blocked: false,
  kind: 'clear' as const,
  overridden: false,
  note: 'clear',
  detail: {
    runElapsedSec: null,
    nextFireInSec: null,
    refiringCandidate: null,
    refireAttempt: null,
    runLockPid: null,
    runLockCgroupPath: null,
    targetCgroupPath: null,
    cgroupRelation: 'unknown' as const,
  },
});

const clearGitSyncCollision = () => ({
  blocked: false,
  kind: 'clear' as const,
  overridden: false,
  note: 'clear',
  detail: {
    targetCgroupPath: null,
    collidingResources: [],
    collidingPids: [],
    isolatedResources: [],
    unknownResources: [],
    deadResources: [],
  },
});

const restartModule = await import('./restart');
const tool = restartModule.default;
const { RESTART_TARGETS } = restartModule;
const {
  configureBgHostRestartFreshnessReaderForTests,
  configureStagingRestartReadinessReaderForTests,
  configureSystemdDaemonReloaderForTests,
  evaluateBgHostRestartFreshness,
  restartVerificationHint,
  SYSTEMD_USER_DAEMON_RELOAD,
  waitForStagingRestartReadiness,
} = restartModule;

type Out = { content: { text: string }[] };
type Fence = Pick<FenceToken, 'assertCurrent' | 'seq'>;
type FreshnessSnapshot = {
  bundleMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
  newestSourcePath: string | null;
};
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const freshnessM = vi.fn(
  async (_integrationRoot: string): Promise<FreshnessSnapshot> => ({
    bundleMtimeMs: null,
    newestSourceMtimeMs: null,
    newestSourcePath: null,
  }),
);
const systemdDaemonReloadM = vi.fn(async (): Promise<void> => undefined);
const stagingReadinessM = vi.fn(
  async (before: { mainPid?: number }): Promise<StagingRestartReadiness> => ({
    ready: true,
    observed: true,
    outcome: 'ready' as const,
    pidChanged: true,
    observedPid: (before.mainPid ?? 0) + 1,
    activeState: 'active',
    result: 'success',
    listener: {
      port: 3170,
      checked: true,
      ownedByPid: true,
      ownerVisible: true,
      observedPids: [(before.mainPid ?? 0) + 1],
      detail: 'listener belongs to replacement',
    },
    waitedMs: 5,
  }),
);
/** Drive guardResource's mock as `(spec, run) => run(fence)` — a thin,
 *  explicitly-typed stand-in for the real drain+fence primitive (which has
 *  its own coverage elsewhere) so `run` never infers to `never` through the
 *  generic mock. */
const runGuard =
  (fence: Fence) =>
  async <T>(_spec: GuardSpec, run: (f: FenceToken) => Promise<T>): Promise<GuardOutcome<T>> => ({
    acquired: true,
    result: await run({
      resource: 'test-resource',
      coordinationDomain: 'test-domain',
      lockId: 'L-test',
      mode: 'exclusive',
      seq: fence.seq ?? 1,
      assertCurrent: fence.assertCurrent,
    }),
    lock_id: 'L-test',
  });
const fenceOk = (seq = 1): Fence => ({
  assertCurrent: async () => ({ current: true, live_fence_seq: seq }),
  seq,
});
const fenceStale = (seq = 1): Fence => ({
  assertCurrent: async () => ({ current: false, reason: 'superseded', live_fence_seq: 2 }),
  seq,
});

const ORIGINAL_ENV = process.env.PAPERCUSP_ALLOW_DEV_RESTART;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_ALLOW_DEV_RESTART;
  freshnessM.mockResolvedValue({
    bundleMtimeMs: null,
    newestSourceMtimeMs: null,
    newestSourcePath: null,
  });
  configureBgHostRestartFreshnessReaderForTests(freshnessM);
  configureStagingRestartReadinessReaderForTests(stagingReadinessM);
  configureSystemdDaemonReloaderForTests(systemdDaemonReloadM);
  releaseM.mockResolvedValue({
    released: 1,
    releasedModes: ['exclusive'],
    exclusiveResources: [],
    waiters: {},
  } as never);
  // Benign default: no live main process to report. Individual tests that care
  // about the coalesce-truth check or the restartedFromPid surfacing override it.
  mockResolvedTyped(probeM, { ok: true, mainPid: 0 });
  listeningSocketsM.mockResolvedValue({
    sockets: [],
    matched: 0,
    totalListening: 0,
    truncated: false,
    ownerHidden: 0,
  } as never);
  gatewayHealthM.mockResolvedValue({ reachable: true, detail: 'HTTP 200' });
  preflightM.mockResolvedValue(bootVerdict());
  desktopResolveM.mockResolvedValue({ ok: true, pid: 327001, note: 'verified desktop-dev listener' });
  desktopRestartM.mockResolvedValue({ ok: true, pid: 327001, note: 'verified desktop-dev listener' });
  auditUnsafeM.mockClear();
  orgPgM.mockReturnValue({ sql: { unsafe: auditUnsafeM } } as never);
  gateCollisionM.mockResolvedValue(clearGateCollision());
  gitSyncCollisionM.mockResolvedValue(clearGitSyncCollision());
  quiesceM.mockResolvedValue(quiesceVerdict());
  gitSyncBarrierReleaseM.mockClear();
  gitSyncBarrierM.mockResolvedValue({
    acquired: true,
    resource: 'git-sync',
    lockId: 'barrier-1',
    owner: 'system:dev-restart:git-sync-barrier:42:uuid',
    coordinationDomain: 'workspace-domain',
    expiresAt: '2026-08-27T19:00:00.000Z',
    release: gitSyncBarrierReleaseM,
  });
});

afterAll(() => {
  configureBgHostRestartFreshnessReaderForTests();
  configureStagingRestartReadinessReaderForTests();
  configureSystemdDaemonReloaderForTests();
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_ALLOW_DEV_RESTART;
  else process.env.PAPERCUSP_ALLOW_DEV_RESTART = ORIGINAL_ENV;
});

describe('evaluateBgHostRestartFreshness (WI-207443)', () => {
  it('reports changed-tree freshness when a runtime source is newer than the produced bundle', () => {
    expect(
      evaluateBgHostRestartFreshness({
        bundleMtimeMs: 10_000,
        newestSourceMtimeMs: 10_001,
        newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
      }),
    ).toEqual({
      bundleMtimeMs: 10_000,
      newestSourceMtimeMs: 10_001,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
      treeChangedSinceRestart: true,
      checked: true,
    });
  });

  it('reports current-tree freshness when the produced bundle is at least as new as runtime sources', () => {
    expect(
      evaluateBgHostRestartFreshness({
        bundleMtimeMs: 10_001,
        newestSourceMtimeMs: 10_000,
        newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
      }),
    ).toMatchObject({ treeChangedSinceRestart: false, checked: true });
  });

  it('reports UNKNOWN freshness when either side cannot be read', () => {
    expect(
      evaluateBgHostRestartFreshness({
        bundleMtimeMs: null,
        newestSourceMtimeMs: 10_000,
        newestSourcePath: 'x.ts',
      }),
    ).toMatchObject({ treeChangedSinceRestart: null, checked: false });
  });
});

describe('dev:restart dry run', () => {
  it('registers every target resource and cooldown marker in the locks migration ledger', () => {
    const sqlDir = new URL('../../../../../libs/papercusp/packages/locks/src/sql/', import.meta.url).pathname;
    const migrations = readdirSync(sqlDir)
      .filter((name) => /^\d{3}-.*\.sql$/.test(name))
      .map((name) => readFileSync(join(sqlDir, name), 'utf8'))
      .join('\n');

    for (const { resource, cooldownResource } of Object.values(RESTART_TARGETS)) {
      expect(migrations, `missing agent_resource_registry seed for ${resource}`).toContain(`('${resource}',`);
      if (cooldownResource) {
        expect(migrations, `missing agent_resource_registry seed for ${cooldownResource}`).toContain(
          `('${cooldownResource}',`,
        );
      }
    }
  });

  it('defaults target to dev and reports the dev unit', async () => {
    const b = body(await call({}));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'dev',
      would_run: 'systemctl --user daemon-reload && systemctl --user restart papercusp-dev-api.service',
    });
    expect(b.note).not.toMatch(/coalesced/);
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('chaining guidance includes both gates for a real restart', () => {
    expect(tool.guidance?.chaining).toMatch(/confirm:true/);
    expect(tool.guidance?.chaining).toMatch(/authorize:true/);
    expect(tool.guidance?.chaining).toMatch(/reason:/);
  });

  it('keeps the registered prompt weight within the budget and hard cap', () => {
    const weight = promptWeight(tool as Parameters<typeof promptWeight>[0]);
    expect(weight).toBeLessThanOrEqual(BUDGET);
    expect(weight).toBeLessThanOrEqual(HARD_CAP);
  });

  it('generated tool catalog preserves the real-restart enablement gates', () => {
    const catalogPath = new URL('../../../../../.papercusp/tool-catalog.json', import.meta.url).pathname;
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      tools: Array<{ name: string; description?: string; guidance?: { chaining?: string } }>;
    };
    const projected = catalog.tools.find((entry) => entry.name === 'dev:restart');

    expect(projected).toBeDefined();
    expect(projected?.description).toMatch(/authorize:true/);
    expect(projected?.guidance?.chaining).toMatch(/confirm:true/);
    expect(projected?.guidance?.chaining).toMatch(/authorize:true/);
    expect(projected?.guidance?.chaining).toMatch(/reason:/);
  });

  it('target:staging reports the staging unit + mentions the coalescing window', async () => {
    const b = body(await call({ target: 'staging' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'staging',
      would_run: 'systemctl --user daemon-reload && systemctl --user restart papercusp-staging-api.service',
    });
    expect(b.note).toMatch(/coalesced/);
    expect(b.note).toMatch(/~2min/);
  });

  // EI-13307: bg-host's coalesce window is tuned to its REAL cost (the ~13min
  // cross-machine peer-log rejoin freeze, EI-13317) — NOT the generic ~2min
  // window shared by gateway/embed-sidecar. The dry-run note must say so.
  it('target:bg-host advertises its OWN wider ~13min coalescing window (EI-13307), not the generic ~2min one', async () => {
    const b = body(await call({ target: 'bg-host' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'bg-host',
      would_run: 'systemctl --user daemon-reload && systemctl --user restart papercusp-bg-host.service',
    });
    expect(b.note).toMatch(/coalesced/);
    expect(b.note).toMatch(/~13min/);
    expect(b.note).toMatch(/EI-13307/);
    expect(b.note).toMatch(/EI-13317/);
    expect(b.note).not.toMatch(/~2min/);
  });

  it('target:gateway, target:embed-sidecar, and target:mcp-proxy keep the generic ~2min window (unaffected by the bg-host widening)', async () => {
    for (const target of ['gateway', 'embed-sidecar', 'mcp-proxy'] as const) {
      const b = body(await call({ target }));
      expect(b.note).toMatch(/~2min/);
      expect(b.note).not.toMatch(/~13min/);
    }
  });

  it('target:desktop-dev previews the wrapper-owned listener operation with the same identity check as confirmation', async () => {
    const b = body(await call({ target: 'desktop-dev' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'desktop-dev',
      would_run: 'SIGUSR2 recycle verified desktop-dev listener on :3270 (wait for verified wrapper respawn)',
      listener_identity: { checked: true, verified: true, would_block: false, pid: 327001 },
    });
    expect(b.note).toMatch(/exclusive\(desktop-dev-server\)/);
    expect(desktopResolveM).toHaveBeenCalledTimes(1);
    expect(preflightM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('target:desktop-dev dry run surfaces the same identity refusal that confirmation would return', async () => {
    desktopResolveM.mockResolvedValue({
      ok: false,
      pid: 622453,
      reason: 'desktop_dev_identity_mismatch',
      note: 'Listener pid 622453 is not the expected desktop-dev hono-host process; refusing to signal it.',
    });

    const b = body(await call({ target: 'desktop-dev' }));

    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'desktop-dev',
      would_run: null,
      listener_identity: {
        checked: true,
        verified: false,
        would_block: true,
        pid: 622453,
        reason: 'desktop_dev_identity_mismatch',
      },
    });
    expect(b.note).toMatch(/would refuse before draining\/signaling/);
    expect(desktopResolveM).toHaveBeenCalledTimes(1);
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('takes no lock and drains nobody on a dry run', async () => {
    await call({ target: 'staging' });
    expect(acquireM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
  });

  // EI-10896: the gateway/bg-host/embed-sidecar had NO sanctioned restart path —
  // the enum was ['dev','staging'] only, so a gateway fix could ONLY be landed by
  // the raw `systemctl` this tool's own guidance forbids. Guard that every shared
  // unit dispatches to its real systemd unit, and that each cooldown-bearing
  // (shared, coalescing) target advertises the debounce in its dry-run note. If a
  // target is dropped from the enum/TARGETS map, `cfg.unit` throws here.
  it.each([
    ['dev', 'papercusp-dev-api.service', false],
    ['staging', 'papercusp-staging-api.service', true],
    ['gateway', 'papercup-inference-gateway.service', true],
    ['bg-host', 'papercusp-bg-host.service', true],
    ['embed-sidecar', 'papercup-embed-sidecar.service', true],
    ['mcp-proxy', 'papercup-mcp-proxy.service', true],
  ] as const)('target:%s dispatches to %s (coalescing note: %s)', async (target, unit, coalesces) => {
    const b = body(await call({ target }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target,
      would_run: `systemctl --user daemon-reload && systemctl --user restart ${unit}`,
    });
    if (coalesces) expect(b.note).toMatch(/coalesced/);
    else expect(b.note).not.toMatch(/coalesced/);
    expect(acquireM).not.toHaveBeenCalled();
  });
});

// EI-18643120769203916: a withheld restart is a REFUSAL, not a partial success.
// The old code ran this check INSIDE guardResource, so an un-enabled call
// drained the target (leaving it quiesced on old code) and returned ok:true —
// which reads as "the restart happened" to any caller that checks `ok`.
describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART unset', () => {
  it('target:dev REFUSES with ok:false and does NOT drain — no guard, no lock, no audit — and the note points at authorize:true', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'restart_withheld',
      restarted: false,
      drained: false,
    });
    expect(b.note).toMatch(/authorize:\s*true/);
    // The whole point: the refusal happens BEFORE any side effect.
    expect(guardM).not.toHaveBeenCalled();
    // dev has no cooldownResource — the debounce path must never engage for it.
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('target:staging is refused the same way — no drain, and the cooldown marker is never claimed (nothing real happened to debounce)', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'staging' }));
    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      reason: 'restart_withheld',
      restarted: false,
      drained: false,
    });
    expect(guardM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('the refusal states plainly that nothing was done, so ok:false is not read as "drained but not restarted"', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'bg-host' }));
    expect(b).toMatchObject({ ok: false, drained: false, restarted: false });
    expect(b.note).toMatch(/NOTHING was done/i);
    expect(b.note).toMatch(/papercusp-bg-host\.service/);
  });
});

// EI-18198340374286980: an agent cannot set PAPERCUSP_ALLOW_DEV_RESTART on the
// already-running operator process — authorize:true is the in-band equivalent,
// still gated behind confirm:true (the deliberate-action + drain gate), and
// always audited (unlike the raw-systemctl bypass it exists to replace).
// EI-18661647550414959. Unit-testing the preflight proves nothing about whether
// dev:restart CALLS it — these are the call-site assertions. The failure being
// prevented: a restart that returns {ok:true, restarted:true} and then crash-loops
// the service on `[boot-integrity] FATAL` (exit 78), taking routines/git-sync down
// fleet-wide, which is exactly what happened on 2026-07-25.
describe('dev:restart boot-integrity preflight', () => {
  const inconsistent = bootVerdict({
    ok: false,
    missing: ['hono', 'postgres'],
    note: '[boot-integrity] /tree is INCONSISTENT',
  });

  it('REFUSES an inconsistent tree and does NOT drain, lock, restart or audit', async () => {
    // guardResource is deliberately left UNARMED: if the refusal ever regressed, the
    // handler would call it and fail loudly rather than quietly restarting.
    preflightM.mockResolvedValue(inconsistent);

    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'x' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'boot_integrity_inconsistent',
      restarted: false,
      drained: false,
      boot_integrity: { checked: true, missing: ['hono', 'postgres'] },
    });
    // The whole point: the host is left UP on working code. Nothing was disturbed.
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('runs the preflight BEFORE the drain, against the requested target', async () => {
    preflightM.mockResolvedValue(inconsistent);
    await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' });
    expect(preflightM).toHaveBeenCalledWith('bg-host');
  });

  // The mirror of the refusal test above: reaching guardResource IS the proof that the
  // preflight did not block. Asserted that way (rather than by driving a full restart)
  // so this needs no `as never` on the generic guard signature — the lint:mock-cast-escape
  // ratchet is shrink-only, and these tests do not need to climb it.
  it('override_boot_integrity:true proceeds — the restart may itself be the remedy', async () => {
    preflightM.mockResolvedValue(inconsistent);
    await call({ confirm: true, authorize: true, target: 'dev', reason: 'x', override_boot_integrity: true }).catch(
      () => undefined,
    );
    expect(guardM).toHaveBeenCalled();
  });

  // Fails OPEN: a guard that cannot run must never be the reason a wedged host stays
  // wedged. `checked:false` is NOT a clean bill, but it is also not a blocker.
  it('proceeds when the tree could not be inspected (checked:false, ok:true)', async () => {
    preflightM.mockResolvedValue(bootVerdict({ checked: false, lockRoot: null, reason: 'no package-lock.json' }));
    await call({ confirm: true, authorize: true, target: 'dev', reason: 'x' }).catch(() => undefined);
    expect(guardM).toHaveBeenCalled();
  });

  it('previews the verdict in the DRY RUN, where the decision is actually made', async () => {
    preflightM.mockResolvedValue(inconsistent);
    const b = body(await call({ target: 'dev' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      boot_integrity: { checked: true, would_block: true, tree: '/tree', missing: ['hono', 'postgres'] },
    });
  });
});

// WI-2140796: a P-101 seed cut (cut-seed-quiesced.sh) `systemctl --user mask
// --runtime`s bg-host and publishes a marker for its duration. dev:restart's own
// restart command runs detached with stdio ignored (see the `spawn` call below in
// this file), so — before this guard — a masked-unit failure was invisible: the
// tool still reported `ok:true, restarted:true` a moment before systemd silently
// no-op'd against the mask. These assert the refusal fires BEFORE any lock/drain.
describe('dev:restart bg-host quiesce preflight (WI-2140796)', () => {
  const quiesced = (over: Record<string, unknown> = {}) =>
    quiesceVerdict({
      quiesced: true,
      blocked: true,
      marker: {
        pid: 4242,
        unit: 'papercusp-bg-host.service',
        reason: 'release seed cut',
        since: '2026-09-01T20:00:00Z',
        log: '/tmp/p101-seed-cut.log',
      },
      note: "bg-host's unit is masked (pid 4242, since 2026-09-01T20:00:00Z: release seed cut) — a P-101 seed cut (or similar) has it deliberately quiesced.",
      ...over,
    });

  it('REFUSES a quiesced bg-host and does NOT drain, lock, restart or audit', async () => {
    quiesceM.mockResolvedValue(quiesced());
    // guardResource is deliberately left UNARMED, same idiom as the boot-integrity
    // refusal test above: a regression here would call it and fail loudly.
    const b = body(await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'bg-host',
      reason: 'bg_host_quiesced',
      restarted: false,
      drained: false,
      quiesce: { quiesced: true, marker: { pid: 4242 } },
    });
    expect(b.note).toMatch(/NOTHING was done/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('checks the target actually requested, after the enablement gate but before the drain', async () => {
    quiesceM.mockResolvedValue(quiesced());
    await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' });
    expect(quiesceM).toHaveBeenCalledWith('bg-host', false);
  });

  it('never probes quiesce state for a target the guard does not cover (dev)', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk() as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    await call({ confirm: true, authorize: true, target: 'dev', reason: 'x' });
    expect(quiesceM).not.toHaveBeenCalled();
  });

  it('override_quiesce:true proceeds — reaching guardResource is the proof the refusal did not fire', async () => {
    quiesceM.mockResolvedValue(quiesced({ blocked: false, overridden: true }));
    // WI-2140796: bg-host carries a cooldownResource, so a call this far down the
    // pipeline reaches the WI-4221 cooldown claim before guardResource — give it a
    // successful claim, same shape as the other bg-host restart tests below.
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-QUIESCE-OVERRIDE',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    await call({
      confirm: true,
      authorize: true,
      target: 'bg-host',
      reason: 'confirmed safe with the cut holder',
      override_quiesce: true,
    }).catch(() => undefined);
    expect(quiesceM).toHaveBeenCalledWith('bg-host', true);
    expect(guardM).toHaveBeenCalled();
  });

  it('a genuine override is recorded on the result AND the durable audit row', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk(7) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    quiesceM.mockResolvedValue(
      quiesced({
        blocked: false,
        overridden: true,
        marker: {
          pid: 4242,
          unit: 'papercusp-bg-host.service',
          reason: 'release seed cut',
          since: '2026-09-01T20:00:00Z',
          log: '/tmp/p101-seed-cut.log',
        },
      }),
    );
    // WI-2140796: same cooldown-claim reasoning as the test above.
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-QUIESCE-AUDIT',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'bg-host',
        reason: 'confirmed safe with the cut holder',
        override_quiesce: true,
      }),
    );
    expect(b).toMatchObject({ ok: true, restarted: true, quiesceOverridden: { marker: { pid: 4242 } } });
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const [, params] = auditUnsafeM.mock.calls[0]!;
    const details = JSON.parse(params[5] as string);
    expect(details.quiesceOverridden).toMatchObject({ marker: { pid: 4242 } });
  });

  it('previews the quiesce block in the DRY RUN, where the decision is actually made', async () => {
    quiesceM.mockResolvedValue(quiesced());
    const b = body(await call({ target: 'bg-host' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      quiesce: { checked: true, would_block: true, quiesced: true, marker: { pid: 4242 } },
    });
    expect(b.note).toMatch(/quiesced/i);
  });

  it('fails OPEN when the probe itself could not verify state (checked:false, not blocked)', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk() as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    quiesceM.mockResolvedValue(quiesceVerdict({ probeFailed: true }));
    // WI-2140796: same cooldown-claim reasoning as the two tests above — probeFailed
    // fails OPEN (blocked:false), so this call also reaches the bg-host cooldown claim.
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-QUIESCE-PROBE-FAILED',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' }).catch(() => undefined);
    expect(guardM).toHaveBeenCalled();
  });
});

describe('dev:restart confirm:true + authorize:true, PAPERCUSP_ALLOW_DEV_RESTART unset', () => {
  it('reloads current user-unit bytes before scheduling a systemd restart (EI-22480835928661383)', async () => {
    guardM.mockImplementation(runGuard(fenceOk(4)) as never);
    systemdDaemonReloadM.mockImplementationOnce(async () => {
      expect(spawnM).not.toHaveBeenCalled();
    });

    const b = body(await call({ confirm: true, authorize: true, reason: 'load changed drop-in', target: 'dev' }));

    expect(SYSTEMD_USER_DAEMON_RELOAD).toEqual({ command: 'systemctl', args: ['--user', 'daemon-reload'] });
    expect(systemdDaemonReloadM).toHaveBeenCalledTimes(1);
    expect(spawnM).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true, restarted: true, systemdDaemonReloaded: true });
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details.systemdDaemonReloaded).toBe(true);
  });

  it('fails closed before scheduling a restart when daemon-reload fails', async () => {
    guardM.mockImplementation(runGuard(fenceOk(4)) as never);
    systemdDaemonReloadM.mockRejectedValueOnce(new Error('unit parse failed'));

    const b = body(await call({ confirm: true, authorize: true, reason: 'load changed drop-in', target: 'dev' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      drained: true,
      restarted: false,
      reason: 'systemd_daemon_reload_failed',
    });
    expect(b.note).toMatch(/unit parse failed/);
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
  });

  it('fires a real restart on authorize:true alone (no env var needed) and writes an audit_log row tagged viaAuthorizeArg', async () => {
    guardM.mockImplementation(runGuard(fenceOk(5)) as never);

    const b = body(
      await call({ confirm: true, authorize: true, reason: 'landing WI-5471 fix on bg-host', target: 'dev' }),
    );

    expect(b).toMatchObject({
      ok: true,
      target: 'dev',
      restarted: true,
      drained: true,
      enabledVia: 'authorize_arg',
      audited: true,
    });
    expect(spawnM).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining('papercusp-dev-api.service')],
      expect.anything(),
    );
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const [, params] = auditUnsafeM.mock.calls[0]!;
    expect(params[3]).toBe('dev:restart'); // action
    expect(params[4]).toBe('dev'); // subject = target
    const details = JSON.parse(params[5] as string);
    expect(details).toMatchObject({
      target: 'dev',
      viaEnv: false,
      viaAuthorizeArg: true,
      reason: 'landing WI-5471 fix on bg-host',
    });
  });

  it('confirm:true alone (authorize omitted, no env) still withholds — authorize does not implicitly follow from confirm', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'dev' }));
    expect(b).toMatchObject({ ok: false, target: 'dev', reason: 'restart_withheld', restarted: false });
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('authorize:true WITHOUT confirm:true stays a dry run — authorize never bypasses the drain gate', async () => {
    const b = body(await call({ authorize: true, target: 'dev' }));
    expect(b).toMatchObject({ ok: true, dry_run: true, target: 'dev' });
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
  });
});

describe('dev:restart git-sync operation collision guard (WI-222053)', () => {
  const blocked = () => ({
    ...clearGitSyncCollision(),
    blocked: true,
    kind: 'operation-in-flight' as const,
    note: 'Restart REFUSED — git-sync:papercusp is in flight; override_git_sync_collision:true only when wedged.',
    detail: {
      ...clearGitSyncCollision().detail,
      targetCgroupPath: '/user.slice/app.slice/papercusp-bg-host.service',
      collidingResources: ['git-sync:papercusp'],
      collidingPids: [4242],
    },
  });

  it('previews the collision before a caller chooses to confirm', async () => {
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ target: 'bg-host' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      git_sync_collision: {
        kind: 'operation-in-flight',
        would_block: true,
        collidingResources: ['git-sync:papercusp'],
        collidingPids: [4242],
      },
    });
    expect(b.note).toContain('git-sync:papercusp');
    expect(gitSyncCollisionM).toHaveBeenCalledWith('bg-host', false);
  });

  it('previews the DRAIN-BUDGETED call honestly — advisory, not would_block (EI-21930094737784126)', async () => {
    // The preview is where an agent decides whether to fire at all. Reporting
    // would_block:true for a call the confirmed path would NOT refuse deters the
    // correct action — the mirror of EI-21365722353248238, where the preview instead
    // promised a restart the confirmed call refused. Both are the same defect.
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ target: 'bg-host', git_sync_drain_sec: 45 }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      git_sync_collision: {
        kind: 'operation-in-flight',
        would_block: false,
        preflight_advisory: true,
        drain_sec: 45,
        collidingResources: ['git-sync:papercusp'],
      },
    });
    expect(b.note).toContain('git_sync_drain_sec:45');
    expect(b.note).toContain('ADVISORY');
  });

  it('the preview and the confirmed path never disagree about whether the preflight blocks', async () => {
    // The anti-drift guard for the shared predicate. Two hand-maintained copies of
    // `blocked && drain === 0` would diverge silently, and the preview diverging is
    // the expensive direction (an agent stands down on a lever that would have fired).
    for (const drain of [0, 45]) {
      gitSyncCollisionM.mockResolvedValue(blocked());
      const preview = body(await call({ target: 'bg-host', ...(drain ? { git_sync_drain_sec: drain } : {}) }));

      gitSyncCollisionM.mockResolvedValue(blocked());
      // Let the confirmed path reach its own preflight decision and stop just after
      // it: the cooldown claim succeeds, then the barrier refuses. Anything the call
      // does past the preflight is not what this test compares.
      mockResolvedTyped(acquireM, {
        ok: true,
        mode: 'exclusive',
        status: 'held',
        lock_id: 'COOL-PARITY',
        expires_ts: new Date(),
        shared_holders: [],
        fence_seq: 1,
      });
      gitSyncBarrierM.mockResolvedValue({
        acquired: false,
        resource: 'git-sync',
        reason: 'drain_timeout',
        holders: [],
      });
      const confirmed = body(
        await call({
          confirm: true,
          authorize: true,
          target: 'bg-host',
          reason: 'preflight parity probe',
          ...(drain ? { git_sync_drain_sec: drain } : {}),
        }),
      );
      const confirmedRefusedOnPreflight = confirmed.reason === 'git_sync_collision_operation_in_flight';
      expect(preview.git_sync_collision.would_block).toBe(confirmedRefusedOnPreflight);
    }
  });

  it('a preview WITHOUT a budget names git_sync_drain_sec as the way through, not the override', async () => {
    // #do-not-override-gitsync: the refusal used to point only at
    // override_git_sync_collision, which SIGKILLs a commit mid-flight. The lever a
    // refused caller reads about must be the safe one.
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ target: 'bg-host' }));
    expect(b.git_sync_collision.would_block).toBe(true);
    expect(b.note).toContain('git_sync_drain_sec');
    expect(b.note).toContain('WEDGED');
  });

  it('refuses before cooldown, drain, signal, or audit when the target cgroup owns the live operation', async () => {
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'reload code' }));
    expect(b).toMatchObject({
      ok: false,
      reason: 'git_sync_collision_operation_in_flight',
      restarted: false,
      drained: false,
      git_sync_collision: { collidingPids: [4242] },
    });
    expect(gateCollisionM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('with a drain budget, the cgroup preflight is ADVISORY and the barrier arbitrates instead', async () => {
    // EI-21930094737784126. The preflight asks "is a git-sync PROCESS inside this
    // cgroup?" — on bg-host the worker IS the host process, so it is ~always true and
    // hard-refused 20/20 real attempts, making the stale-executor page's own named
    // remediation unfireable. The authoritative signal is the barrier LOCK, measured
    // FREE in 20 of 40 sampled seconds. A caller willing to wait must reach it.
    gitSyncCollisionM.mockResolvedValue(blocked());
    // Let the cooldown claim succeed so the call actually reaches the barrier; the
    // barrier then refuses, which is what proves the preflight is no longer the gate.
    // mockResolvedTyped, not `as never`: the cast would defeat the one check vi.mocked
    // gives us, and lint:mock-cast-escape is shrink-only.
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-DRAIN',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    gitSyncBarrierM.mockResolvedValue({ acquired: false, resource: 'git-sync', reason: 'drain_timeout', holders: [] });

    const b = body(
      await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'reload code', git_sync_drain_sec: 45 }),
    );

    // It got PAST the preflight — the refusal now comes from the barrier, not the proxy.
    expect(b.reason).not.toBe('git_sync_collision_operation_in_flight');
    expect(gitSyncBarrierM).toHaveBeenCalled();
    expect(gitSyncBarrierM).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ maxDrainSec: 45 }),
    );
    expect(workspaceTxnM).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), {
      minLockTimeoutMs: 45_000,
      minStatementTimeoutMs: 45_000,
    });
  });

  it('with NO drain budget the preflight still hard-refuses — the default path is unchanged', async () => {
    // The other half of the guard above: demoting the preflight unconditionally would
    // remove a real protection for every caller who did not opt in.
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'reload code' }));
    expect(b.reason).toBe('git_sync_collision_operation_in_flight');
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
  });

  it('covers the :3070 dev target, not only scheduled bg-host fires', async () => {
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));
    expect(b.reason).toBe('git_sync_collision_operation_in_flight');
    expect(gitSyncCollisionM).toHaveBeenCalledWith('dev', false);
  });

  it('passes a deliberate override, surfaces it, and records operation identity in the restart audit', async () => {
    gitSyncCollisionM.mockResolvedValue({ ...blocked(), blocked: false, overridden: true });
    guardM.mockImplementation(runGuard(fenceOk(17)) as never);

    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'dev',
        reason: 'git-sync worker itself is wedged',
        override_git_sync_collision: true,
      }),
    );

    expect(b).toMatchObject({
      ok: true,
      restarted: true,
      gitSyncCollisionOverridden: {
        kind: 'operation-in-flight',
        collidingResources: ['git-sync:papercusp'],
        collidingPids: [4242],
      },
    });
    expect(gitSyncCollisionM).toHaveBeenCalledWith('dev', true);
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details.gitSyncCollision).toEqual({
      kind: 'operation-in-flight',
      overridden: true,
      resources: ['git-sync:papercusp'],
      pids: [4242],
    });
  });

  it('closes the post-check race: a held barrier refuses before the target drains', async () => {
    gitSyncCollisionM.mockResolvedValue(clearGitSyncCollision());
    gitSyncBarrierM.mockResolvedValue({
      acquired: false,
      resource: 'git-sync',
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'system:git-sync:99:late',
          owner_label: 'git-sync:papercusp',
          mode: 'exclusive',
          status: 'held',
        },
      ],
    });
    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));

    expect(b).toMatchObject({
      ok: false,
      reason: 'git_sync_barrier_held_exclusive',
      restarted: false,
      drained: false,
      resource: 'git-sync',
      holders: [{ owner: 'system:git-sync:99:late' }],
    });
    expect(gitSyncBarrierM).toHaveBeenCalledTimes(1);
    expect(guardM).not.toHaveBeenCalled();
    expect(b.note).toMatch(/before draining/i);
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('retries transient workspace contention while acquiring the barrier', async () => {
    guardM.mockImplementation(runGuard(fenceOk(18)) as never);
    const contention = Object.assign(new Error('workspace lock timed out'), {
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });
    gitSyncBarrierM.mockRejectedValueOnce(contention).mockResolvedValueOnce({
      acquired: true,
      resource: 'git-sync',
      lockId: 'barrier-retry',
      owner: 'system:dev-restart:git-sync-barrier:42:retry',
      coordinationDomain: 'workspace-domain',
      expiresAt: '2026-08-27T19:00:00.000Z',
      release: gitSyncBarrierReleaseM,
    });

    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));

    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true, drained: true });
    expect(gitSyncBarrierM).toHaveBeenCalledTimes(2);
    expect(guardM).toHaveBeenCalledTimes(1);
    expect(spawnM).toHaveBeenCalledTimes(1);
  });

  it('releases an acquired barrier when the target drain never grants', async () => {
    guardM.mockResolvedValue({ acquired: false, reason: 'drain_timeout', holders: [] } as never);

    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'resource_drain_timeout',
    });
    expect(gitSyncBarrierM).toHaveBeenCalledTimes(1);
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('keeps the successful barrier lease through the delayed systemctl handoff', async () => {
    guardM.mockImplementation(runGuard(fenceOk(19)) as never);
    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));
    expect(b.gitSyncRestartBarrier).toEqual({
      resource: 'git-sync',
      expiresAt: '2026-08-27T19:00:00.000Z',
      release: 'lease-expiry-after-systemctl-handoff',
    });
    expect(spawnM).toHaveBeenCalledTimes(1);
    expect(gitSyncBarrierReleaseM).not.toHaveBeenCalled();
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details.gitSyncBarrier).toEqual({ resource: 'git-sync', expiresAt: '2026-08-27T19:00:00.000Z' });
  });

  it('releases the barrier immediately when scheduling the restart throws', async () => {
    guardM.mockImplementation(runGuard(fenceOk(20)) as never);
    spawnM.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    await expect(call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' })).rejects.toThrow(
      'spawn failed',
    );
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:staging', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('claims the cooldown marker, drains+restarts, and does NOT release the cooldown on success', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL1',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(9)) as never);
    // EI-11137: the pre-restart MainPID is captured so the caller can verify a real cycle.
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(acquireM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'staging-server-cooldown', mode: 'exclusive', ttlSec: 120 }),
    );
    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: true,
      drained: true,
      restartedFromPid: 4242,
      enabledVia: 'env',
      audited: true,
    });
    expect(b.verifyWith).toMatch(/dev:listening_ports \{ port: 3170 \}/);
    expect(b.verifyWith).toMatch(/ownerVisible:true/);
    expect(b.verifyWith).toMatch(/MainPID=0.*ActiveState=activating|ActiveState=activating.*MainPID=0/);
    expect(b).not.toHaveProperty('phantomCoalesceBroken');
    expect(spawnM).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining('papercusp-staging-api.service')],
      expect.anything(),
    );
    expect(spawnM.mock.calls[0]?.[1]?.[1] as string).not.toContain('reset-failed');
    // Left to expire, not released — the debounce depends on this.
    expect(releaseM).not.toHaveBeenCalled();
    // EI-18198340374286980: a real restart is ALWAYS audited, even via the env route.
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details).toMatchObject({ target: 'staging', viaEnv: true, viaAuthorizeArg: false, reason: null });
  });

  it('retries transient workspace contention while acquiring the staging cooldown marker', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-RETRY',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 22,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(22)) as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });
    workspaceTxnM.mockRejectedValueOnce(
      Object.assign(new Error('workspace lock timed out'), {
        name: 'WorkspaceContendedError',
        pgCode: '57014',
      }),
    );

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: true, drained: true });
    expect(workspaceTxnM).toHaveBeenCalledTimes(2);
    expect(acquireM).toHaveBeenCalledTimes(1);
    expect(guardM).toHaveBeenCalledTimes(1);
    expect(spawnM).toHaveBeenCalledTimes(1);
  });

  it('staging restart bypasses the git-sync probe and workspace barrier', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-STAGING-NO-GITSYNC',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 21,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(21)) as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: true, drained: true });
    expect(gitSyncCollisionM).not.toHaveBeenCalled();
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
  });

  it('clears a latched start-limit before scheduling the restart and reports the recovery', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-LATCH',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(10)) as never);
    probeM.mockResolvedValue({ ok: true, mainPid: 0, result: 'start-limit-hit' } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: true,
      resetFailedBeforeRestart: true,
    });
    const shell = spawnM.mock.calls[0]?.[1]?.[1] as string;
    const reset = `systemctl --user reset-failed papercusp-staging-api.service`;
    const restart = `systemctl --user restart papercusp-staging-api.service`;
    expect(shell).toContain(`${reset} && ${restart}`);
    expect(shell.indexOf(reset)).toBeLessThan(shell.indexOf(restart));
    expect(b.note).toMatch(/start-limit|reset-failed/i);
  });

  it('also clears a failed MainPID=0 unit when systemd retains Result=exit-code', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-EXIT-CODE-LATCH',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(10)));
    mockResolvedTyped(probeM, {
      ok: true,
      mainPid: 0,
      activeState: 'failed',
      result: 'exit-code',
    });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: true,
      resetFailedBeforeRestart: true,
      stagingReadiness: { ready: true, observed: true, outcome: 'ready' },
    });
    expect(spawnM.mock.calls[0]?.[1]?.[1] as string).toContain(
      'systemctl --user reset-failed papercusp-staging-api.service && systemctl --user restart papercusp-staging-api.service',
    );
  });

  it('does not report restarted when the detached staging command is not observed succeeding', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-NOT-OBSERVED',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(10)));
    mockResolvedTyped(probeM, { ok: true, mainPid: 0, activeState: 'failed', result: 'exit-code' });
    stagingReadinessM.mockResolvedValueOnce({
      ready: false,
      observed: false,
      outcome: 'failed',
      pidChanged: false,
      observedPid: null,
      activeState: 'failed',
      result: 'exit-code',
      listener: null,
      waitedMs: 10_000,
    });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      restarted: false,
      restartScheduled: true,
      restartObserved: false,
      stagingReadiness: { outcome: 'failed' },
    });
    expect(b.note).toMatch(/do not claim it restarted/i);
  });

  it('observes the real staging transition through new-PID listener ownership', async () => {
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 5252, activeState: 'active', result: 'success' });
    mockResolvedTyped(listeningSocketsM, {
      ...gatewayListenerResult(5252),
      sockets: gatewayListenerResult(5252).sockets.map((socket) => ({ ...socket, port: 3170 })),
    });

    const readiness = await waitForStagingRestartReadiness({
      ok: true,
      mainPid: 0,
      activeState: 'failed',
      result: 'exit-code',
    });

    expect(readiness).toMatchObject({
      ready: true,
      observed: true,
      outcome: 'ready',
      pidChanged: true,
      observedPid: 5252,
      listener: { port: 3170, ownedByPid: true },
    });
  });

  it('coalesces when the marker is held AND systemd confirms a genuine recent restart — no drain, no restart, no spawn', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'peer-1',
          owner_label: 'peer-one',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    // EI-11137: the service really did restart 12s ago (< 120s window) — genuine coalesce.
    mockResolvedTyped(probeM, { ok: true, mainPid: 555, secondsSinceStart: 12 });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: false,
      coalesced: true,
      verified: true,
      restartedSecondsAgo: 12,
      mainPid: 555,
    });
    expect(b.note).toMatch(/peer-one/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('coalesces a recent bg-host restart but explicitly reports a changed tree whose edit is not loaded', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          resource: 'bg-host-cooldown',
          lock_id: 'lock-peer-bg-6060',
          owner: 'peer-bg',
          owner_label: 'peer-bg-host',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          acquired_ts: new Date(),
          expires_ts: new Date(),
          fence_seq: 1,
        },
      ],
    });
    probeM.mockResolvedValue({ ok: true, mainPid: 6060, secondsSinceStart: 600 });
    freshnessM.mockResolvedValue({
      bundleMtimeMs: 10_000,
      newestSourceMtimeMs: 10_001,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'bg-host',
      restarted: false,
      coalesced: true,
      verified: true,
      restartedSecondsAgo: 600,
      mainPid: 6060,
      treeChangedSinceRestart: true,
      freshnessVerified: true,
      bundleMtime: new Date(10_000).toISOString(),
      newestSourceMtime: new Date(10_001).toISOString(),
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });
    expect(b.note).toMatch(/runtime tree is newer than the bundle/i);
    expect(b.note).toMatch(/requested edit is NOT loaded/i);
    expect(b.note).toMatch(/temporal throttle is preserved/i);
    expect(freshnessM).toHaveBeenCalledTimes(1);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('coalesces a recent bg-host restart and reports current tree/bundle freshness', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          resource: 'bg-host-cooldown',
          lock_id: 'lock-peer-bg-6061',
          owner: 'peer-bg',
          owner_label: 'peer-bg-host',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          acquired_ts: new Date(),
          expires_ts: new Date(),
          fence_seq: 1,
        },
      ],
    });
    probeM.mockResolvedValue({ ok: true, mainPid: 6061, secondsSinceStart: 12 });
    freshnessM.mockResolvedValue({
      bundleMtimeMs: 10_001,
      newestSourceMtimeMs: 10_000,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      coalesced: true,
      treeChangedSinceRestart: false,
      freshnessVerified: true,
    });
    expect(b.note).toMatch(/freshness checked/i);
    expect(b.note).not.toMatch(/NOT loaded/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('EI-11137: PHANTOM coalesce — marker held but systemd shows NO recent restart ⇒ refuses to coalesce and fires a real restart', async () => {
    // The reported wedge: a bg-host marker is held, but the service last started
    // long ago (older than the cooldown). Must NOT coalesce — must restart.
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'stale-peer',
          owner_label: 'stale-one',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 909, secondsSinceStart: 6 * 3600 }); // 6h ago
    guardM.mockImplementation(runGuard(fenceOk(7)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 909 });
    expect(b.coalesced).toBeUndefined();
    // EI-13307: bg-host's cooldown is now the widened ~13min (780s) window, not the generic 120s one.
    expect(b.phantomCoalesceBroken).toMatchObject({
      staleMarkerHolder: 'stale-one',
      serviceSecondsSinceStart: 6 * 3600,
      cooldownSec: 13 * 60,
    });
    expect(spawnM).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining('papercusp-bg-host.service')],
      expect.anything(),
    );
  });

  it('EI-11137: down service (MainPID 0) is NOT a recent restart ⇒ marker treated as phantom, restart fires', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'stale-peer',
          owner_label: 'stale-one',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 0 }); // no live main process
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
      holders: [
        {
          owner: 'peer-1',
          owner_label: 'peer-one',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    mockResolvedTyped(probeM, { ok: false }); // no systemd / probe error

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: false, coalesced: true, verified: false });
    expect(b.note).toMatch(/could NOT be verified/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('releases the cooldown marker if the drain/restart step aborts after claiming it (stale fence)', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL2',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockImplementation(runGuard(fenceStale()) as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: false, target: 'staging', reason: 'stale_fence_superseded' });
    expect(releaseM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lockId: 'COOL2' }));
  });

  it('releases the cooldown marker if the drain-gate itself never grants (e.g. drain_timeout)', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL3',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockResolvedValue({ acquired: false, reason: 'drain_timeout', holders: [] } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      reason: 'resource_drain_timeout',
      resource: 'staging-server',
    });
    expect(releaseM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lockId: 'COOL3' }));
  });
});

describe('dev:restart gateway readiness (EI-21651903020639415)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('waits for a new MainPID before probing /healthz and only then reports restarted:true', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-GATEWAY-READY',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 31,
    } as never);
    // The first probe is the pre-restart baseline; the next two model systemd
    // still exposing the old process before the detached restart lands, then a
    // new process. Health must not be probed against either old-PID observation.
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9998 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 5252, secondsSinceStart: 1 } as never);
    listeningSocketsM.mockResolvedValue(gatewayListenerResult(5252));
    mockResolvedTyped(gatewayHealthM, { reachable: true, detail: 'HTTP 200' });
    guardM.mockImplementation(runGuard(fenceOk(31)) as never);

    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'gateway',
        reason: 'verify the gateway restart readiness contract',
      }),
    );

    expect(b).toMatchObject({
      ok: true,
      target: 'gateway',
      drained: true,
      restarted: true,
      restartedFromPid: 4242,
      gatewayReadiness: {
        ready: true,
        pidChanged: true,
        observedPid: 5252,
        health: { reachable: true, detail: 'HTTP 200' },
      },
    });
    expect(gatewayHealthM).toHaveBeenCalledTimes(1);
    expect(gatewayHealthM.mock.calls[0]?.[0]).toMatch(/127\.0\.0\.1:\d+\/healthz$/);
    expect(probeM.mock.invocationCallOrder.at(-1)).toBeLessThan(gatewayHealthM.mock.invocationCallOrder[0]!);
    expect(b.verifyWith).toMatch(/healthz/);
    expect(b.note).toMatch(/MainPID changed to 5252/);
  });

  it('returns a distinct scheduled/not-ready result when the new PID never answers /healthz', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-GATEWAY-NOT-READY',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 32,
    } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 5252, secondsSinceStart: 1 } as never);
    listeningSocketsM.mockResolvedValue(gatewayListenerResult(5252));
    mockResolvedTyped(gatewayHealthM, { reachable: false, detail: 'ConnectionRefused' });
    guardM.mockImplementation(runGuard(fenceOk(32)) as never);

    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'gateway',
        reason: 'exercise the not-ready response',
      }),
    );

    expect(b).toMatchObject({
      ok: false,
      target: 'gateway',
      drained: true,
      restarted: false,
      restartScheduled: true,
      gatewayReadiness: {
        ready: false,
        pidChanged: true,
        observedPid: 5252,
        health: { reachable: false, detail: 'ConnectionRefused' },
      },
    });
    expect(b.verifyWith).toMatch(/healthz/);
    expect(b.note).toMatch(/readiness was NOT confirmed|Do not send requests yet/i);
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:bg-host (EI-13307 widened cooldown)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('uses bounded startup polling for the portless bg-host and labels MainPID=0/activating as transient', () => {
    const hint = restartVerificationHint('bg-host', 'papercusp-bg-host.service', 7777);
    expect(hint).toContain('Bounded poll (up to ~30s)');
    expect(hint).toMatch(/MainPID.*nonzero/);
    expect(hint).toMatch(/ActiveState/);
    expect(hint).toContain('MainPID=0 with ActiveState=activating means still starting, NOT failed');
    expect(hint).toContain('differs from 7777');
    expect(hint).not.toContain('dev:listening_ports');
  });

  it('claims the bg-host cooldown marker with the WIDENED ~13min TTL (780s), not the generic 120s one', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-BG',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(11)) as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 7777, secondsSinceStart: 99999 });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(acquireM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'bg-host-cooldown', mode: 'exclusive', ttlSec: 13 * 60 }),
    );
    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, drained: true, restartedFromPid: 7777 });
    // (b): the result states the rail-freeze cost explicitly, referencing EI-13317.
    expect(b.note).toMatch(/~13min/);
    expect(b.note).toMatch(/EI-13317/);
  });

  it("a restart request ~10min (600s) after a peer's real bg-host restart COALESCES under the widened window — the exact storm from EI-13307 (old 120s window would have fired a fresh restart here)", async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'peer-2',
          owner_label: 'peer-two',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    // 600s ago: outside the OLD 120s window (would have been a phantom / real
    // restart under the pre-fix code) but well inside the NEW 780s window.
    mockResolvedTyped(probeM, { ok: true, mainPid: 8888, secondsSinceStart: 600 });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'bg-host',
      restarted: false,
      coalesced: true,
      verified: true,
      restartedSecondsAgo: 600,
      mainPid: 8888,
    });
    expect(b.note).toMatch(/peer-two/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it("a restart request >13min (900s) after a peer's real bg-host restart is OUTSIDE even the widened window — fires a genuine restart", async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'peer-3',
          owner_label: 'peer-three',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 4321, secondsSinceStart: 900 });
    guardM.mockImplementation(runGuard(fenceOk(12)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 4321 });
    expect(b.coalesced).toBeUndefined();
    expect(b.phantomCoalesceBroken).toMatchObject({
      staleMarkerHolder: 'peer-three',
      serviceSecondsSinceStart: 900,
      cooldownSec: 13 * 60,
    });
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:dev (unaffected by the debounce)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('uses the :3070 listener as the restart readiness contract instead of a one-shot MainPID read', async () => {
    guardM.mockImplementation(runGuard(fenceOk(3)) as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });

    const b = body(await call({ confirm: true }));

    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true, restartedFromPid: 4242 });
    expect(b.verifyWith).toMatch(/dev:listening_ports \{ port: 3070 \}/);
    expect(b.verifyWith).toMatch(/ownerVisible:true/);
    expect(b.verifyWith).toMatch(/different from 4242/);
    expect(b.verifyWith).not.toMatch(/systemctl --user show/);
  });

  it('never touches the cooldown machinery for dev', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk(3) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true });
    expect(acquireM).not.toHaveBeenCalled();
    expect(releaseM).not.toHaveBeenCalled();
    expect(spawnM).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining('papercusp-dev-api.service')],
      expect.anything(),
    );
  });

  it('target:desktop-dev drains the named resource and signals only the verified listener child', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk(7) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    const b = body(
      await call({ target: 'desktop-dev', confirm: true, authorize: true, reason: 'reload desktop operator edit' }),
    );
    expect(b).toMatchObject({
      ok: true,
      target: 'desktop-dev',
      drained: true,
      restarted: true,
      listenerPid: 327001,
      enabledVia: 'env',
      audited: true,
    });
    expect(desktopRestartM).toHaveBeenCalledTimes(1);
    expect(guardM).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'desktop-dev-server', mode: 'exclusive' }),
      expect.any(Function),
    );
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details).toMatchObject({ target: 'desktop-dev', unit: 'desktop-dev-wrapper' });
  });
});

// EI-22040822883429888: guardResource's exclusive drain wait fires spec.onTick every
// ~5s while draining (resource-acquire-wait.ts), and db:migrate already forwards that
// into ctx.progress (EI-18769559897594065) so a long-draining MCP call doesn't look
// indistinguishable from a wedge to the client's idle-timeout watchdog. dev:restart's
// guardResource call omitted onTick entirely — this locks in the same wiring here.
describe('dev:restart drain progress -> ctx.progress heartbeat (EI-22040822883429888)', () => {
  const progressCtx = () => {
    const progress = vi.fn();
    return { ctx: { role: 'operator', progress } as never, progress };
  };

  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('wires a spec.onTick callback into guardResource that forwards to ctx.progress as a draining-phase tick', async () => {
    const { ctx, progress } = progressCtx();
    mockImplementationTyped(guardM, async (spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      spec.onTick?.({
        waited_sec: 12,
        holders: [{ owner: 'su-peer', owner_label: 'peer', mode: 'shared', status: 'draining' } as never],
      });
      return { acquired: true, result: await run(fenceOk(30) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    await tool.handler({ confirm: true, max_drain_sec: 45 } as never, ctx);
    expect(progress).toHaveBeenCalled();
    const draining = progress.mock.calls.map((c) => JSON.parse(c[1] as string)).find((p) => p.phase === 'draining');
    expect(draining).toMatchObject({ phase: 'draining', elapsed_sec: 12, max_drain_sec: 45, remaining_sec: 33 });
    expect(draining.holders[0]).toMatchObject({ owner: 'su-peer', mode: 'shared' });
  });

  it('falls back to the tool default max_drain_sec when the caller does not override it', async () => {
    const { ctx, progress } = progressCtx();
    mockImplementationTyped(guardM, async (spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      spec.onTick?.({ waited_sec: 10, holders: [] });
      return { acquired: true, result: await run(fenceOk(32) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    await tool.handler({ confirm: true } as never, ctx);
    const draining = progress.mock.calls.map((c) => JSON.parse(c[1] as string)).find((p) => p.phase === 'draining');
    // 120 mirrors restart.ts's own module-local DEFAULT_DRAIN_SEC (not exported, so
    // pinned literally here — a change to that constant should fail this assertion).
    expect(draining).toMatchObject({ phase: 'draining', elapsed_sec: 10, max_drain_sec: 120 });
  });

  it('does not throw when ctx has no progress function (older transport shape)', async () => {
    mockImplementationTyped(guardM, async (spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      spec.onTick?.({ waited_sec: 5, holders: [] });
      return { acquired: true, result: await run(fenceOk(31) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    const out = body(await call({ confirm: true }));
    expect(out.ok).toBe(true);
  });
});
