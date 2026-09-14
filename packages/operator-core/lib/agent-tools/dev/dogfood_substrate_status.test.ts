/**
 * dogfood_substrate_status.test.ts — the dev:dogfood_substrate_status HANDLER (the
 * substrate composer + the PG claim-stat loader are mocked). The genuine handler logic is
 * the TWO-PASS refresh: pass 1 composes a PG-free status; if any harness booted, it loads
 * real claim stats per harness and RE-derives the status with those stats keyed by
 * workspace::slug. Pins: the empty-harness short-circuit (no PG load), and that the real
 * stats reach the second-pass resolveClaimStats (the verdict reflects real error rates).
 *
 * Also covers (EI-19327550671915579): `withPgBootedHandlesFallback` — the cross-SERVICE
 * PG leg consulted only when the fast in-process/cluster-IPC path reported
 * `reachedSubstrateOwner: false` (the dedicated-bg-host blind spot; see
 * substrate-booted-handles-pg.ts's file header). Before this, no test anywhere exercised
 * this helper's actual recompute-on-fallback-hit behavior — every existing test mocked
 * `getInProcessSubstrateStatus` wholesale (never setting `reachedSubstrateOwner`, so the
 * helper always took the "not reached" branch) while leaving the real
 * `getPgBootedHandlesSnapshotFallback` unmocked, silently relying on it failing/returning
 * null in this environment rather than deliberately asserting the fallback contract.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/dogfood_substrate_status.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../sync/hyperbee/in-process-status', () => ({ getInProcessSubstrateStatus: vi.fn() }));
vi.mock('../../sync/hyperbee/boot-all', () => ({ getBootedHarness: vi.fn() }));
vi.mock('../../orchestrator/load-claim-attempts', () => ({ loadClaimAttemptStats: vi.fn() }));
vi.mock('../../sync/hyperbee/substrate-booted-handles-pg', () => ({ getPgBootedHandlesSnapshotFallback: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: { unsafe: vi.fn(async () => []) } })),
}));

import {
  type GetInProcessStatusOpts,
  getInProcessSubstrateStatus,
  type InProcessSubstrateStatus,
} from '../../sync/hyperbee/in-process-status';
import { getBootedHarness } from '../../sync/hyperbee/boot-all';
import { loadClaimAttemptStats } from '../../orchestrator/load-claim-attempts';
import { getPgBootedHandlesSnapshotFallback } from '../../sync/hyperbee/substrate-booted-handles-pg';
const statusM = vi.mocked(getInProcessSubstrateStatus);
const bootedM = vi.mocked(getBootedHarness);
const statsM = vi.mocked(loadClaimAttemptStats);
const pgM = vi.mocked(getPgBootedHandlesSnapshotFallback);
const tool = (await import('./dogfood_substrate_status')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const run = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;

beforeEach(() => {
  vi.clearAllMocks();
  bootedM.mockReturnValue(null);
  pgM.mockResolvedValue(null); // default: no cross-service row (the common case)
});

describe('dev:dogfood_substrate_status handler', () => {
  it('publishes the harnesses[] root in the registered output contract', () => {
    const definition = tool as unknown as {
      guidance?: { returns?: string };
      result: { safeParse: (value: unknown) => { success: boolean } };
    };
    expect(definition.guidance?.returns).toContain('harnesses[]');
    expect(
      definition.result.safeParse({
        substrateActive: true,
        bootedCount: 1,
        summary: { totalHarnesses: 1, worstVerdict: 'healthy' },
        harnesses: [],
        logStats: [],
        replicationLiveness: [],
        contentConnectivity: [],
        reachedSubstrateOwner: true,
        healthInputsObserved: true,
      }).success,
    ).toBe(true);
  });

  it('short-circuits when no harness booted (no PG claim-stat load)', async () => {
    statusM.mockReturnValue({ harnesses: [], summary: { ok: true } } as never);
    const b = body(await run());
    expect(b).toMatchObject({ harnesses: [], summary: { ok: true } });
    expect(statsM).not.toHaveBeenCalled();
  });

  it('refreshes the verdict with real per-harness claim stats (two-pass)', async () => {
    // The composer echoes whatever resolveClaimStats returns for ws::web, so we can
    // observe which stats reached each pass.
    statusM.mockImplementation((opts?: GetInProcessStatusOpts) => ({
      harnesses: [{ workspaceId: 'ws', harnessSlug: 'web' }],
      probe: opts?.resolveClaimStats?.('ws', 'web'),
    }) as never);
    statsM.mockResolvedValue({ total: 10, won: 8, lost: 1, error: 1 } as never);

    const b = body(await run());
    expect(statsM).toHaveBeenCalledTimes(1);
    expect(statsM.mock.calls[0]![0]).toMatchObject({ workspace_id: 'ws', harness_slug: 'web' });
    // the RETURNED status is the second pass, whose resolveClaimStats yields the real stats
    expect(b.probe).toMatchObject({ total: 10, won: 8, error: 1 });
  });

  it('narrows every per-harness array to one exact target before result shaping', async () => {
    const a = { workspaceId: 'ws', harnessSlug: 'a' };
    const b = { workspaceId: 'ws', harnessSlug: 'b' };
    statusM.mockReturnValue({
      bootedCount: 2,
      harnesses: [
        { ...a, verdict: 'healthy', reasons: [] },
        { ...b, verdict: 'healthy', reasons: [] },
      ],
      logStats: [{ ...a, ownLogOps: 1 }, { ...b, ownLogOps: 2 }],
      replicationLiveness: [{ ...a, counts: {} }, { ...b, counts: {} }],
      contentConnectivity: [
        { ...a, topicHex: 'aa'.repeat(32), contentPeers: 0, lastContentAnnounceRecvMs: null },
        { ...b, topicHex: 'bb'.repeat(32), contentPeers: 1, lastContentAnnounceRecvMs: 12_345 },
      ],
      summary: {},
      reachedSubstrateOwner: true,
    } as never);

    const out = body(await run({ targetHarness: b }));
    expect(out.bootedCount).toBe(2); // aggregate stays workspace-wide
    expect(out.harnesses).toEqual([expect.objectContaining(b)]);
    expect(out.logStats).toEqual([expect.objectContaining(b)]);
    expect(out.replicationLiveness).toEqual([expect.objectContaining(b)]);
    expect(out.contentConnectivity).toEqual([
      expect.objectContaining({ ...b, contentPeers: 1 }),
    ]);
  });

  it('does not report a targeted zero-handle population as healthy', async () => {
    const zeroHandleStatus: InProcessSubstrateStatus = {
      substrateActive: true,
      bootedCount: 0,
      harnesses: [],
      logStats: [],
      replicationLiveness: [],
      contentConnectivity: [],
      summary: {
        enabled: true,
        totalHarnesses: 0,
        healthy: 0,
        booting: 0,
        degraded: 0,
        unhealthy: 0,
        disabled: 0,
        worstVerdict: 'healthy',
      },
      reachedSubstrateOwner: true,
      healthInputsObserved: true,
    };
    statusM.mockReturnValue(zeroHandleStatus);

    const out = body(await run({
      targetHarness: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    }));

    // The aggregate counts remain workspace-wide source facts; only the
    // targeted empty verdict changes so absence cannot read as idle success.
    expect(out.summary).toMatchObject({ totalHarnesses: 0, worstVerdict: 'degraded' });
    expect(out.harnesses).toEqual([]);
  });

  it('tolerates a claim-stat load failure (falls back to zeroed stats)', async () => {
    statusM.mockImplementation((opts?: GetInProcessStatusOpts) => ({
      harnesses: [{ workspaceId: 'ws', harnessSlug: 'web' }],
      probe: opts?.resolveClaimStats?.('ws', 'web'),
    }) as never);
    statsM.mockRejectedValue(new Error('pg down'));
    const b = body(await run());
    expect(b.probe).toMatchObject({ total: 0, won: 0, lost: 0, error: 0 });
  });

  it('reads one exact own-log index through the already-booted handle', async () => {
    statusM.mockReturnValue({ harnesses: [], summary: {}, reachedSubstrateOwner: true } as never);
    bootedM.mockReturnValue({
      ownLog: {
        keyHex: 'e'.repeat(64),
        length: 63212,
        get: vi.fn(async () => ({
          type: 'put',
          table: 'coord_event_log',
          hbKey: '1007851',
          epoch: 84,
        })),
      },
    } as never);

    const b = body(await run({
      ownLogProbe: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', index: 62714 },
    }));

    expect(bootedM).toHaveBeenCalledWith('papercusp-workspace', 'papercusp');
    expect(b.ownLogProbe).toMatchObject({
      available: true,
      index: 62714,
      length: 63212,
      op: { table: 'coord_event_log', hbKey: '1007851', epoch: 84 },
    });
  });
});

describe('dev:dogfood_substrate_status — cross-SERVICE PG fallback (EI-19327550671915579)', () => {
  it('never consults the PG fallback when the fast path already reached the owner', async () => {
    statusM.mockReturnValue({ harnesses: [], summary: {}, reachedSubstrateOwner: true } as never);
    const b = body(await run());
    expect(b).toMatchObject({ reachedSubstrateOwner: true });
    expect(pgM).not.toHaveBeenCalled();
  });

  it('stays reachedSubstrateOwner:false when the fast path missed AND the PG row is absent/stale', async () => {
    statusM.mockReturnValue({ harnesses: [], summary: {}, reachedSubstrateOwner: false } as never);
    pgM.mockResolvedValue(null); // no row yet / stale — getPgBootedHandlesSnapshotFallback's own contract
    const b = body(await run());
    expect(pgM).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ reachedSubstrateOwner: false });
  });

  it('recomputes via the PG snapshot when the fast path missed — this is the dedicated-bg-host blind spot the EI reports', async () => {
    // Pass 1: the in-process/cluster-IPC leg reports the blind spot (this is what a
    // request-only host under the dedicated-bg-host topology sees permanently, per the
    // EI). Recompute (pass 1b) is handed a `resolveRemoteBootedHandles` that returns the
    // PG-derived snapshot — assert it actually reaches that recompute call, and that the
    // recomputed (not the original) status is what the tool returns.
    let sawResolvedRemote: unknown;
    statusM.mockImplementation((opts = {}) => {
      const remote = opts.resolveRemoteBootedHandles?.();
      if (remote) {
        sawResolvedRemote = remote;
        return { harnesses: [], summary: {}, reachedSubstrateOwner: true, booted: (remote as { handles: unknown }).handles } as never;
      }
      return { harnesses: [], summary: {}, reachedSubstrateOwner: false } as never;
    });
    const pgSnapshot = { handles: [{ workspaceId: 'ws1', harnessSlug: 'papercup' }], receivedAt: 12_345 };
    pgM.mockResolvedValue(pgSnapshot);

    const b = body(await run());
    expect(pgM).toHaveBeenCalledTimes(1);
    expect(sawResolvedRemote).toEqual(pgSnapshot);
    expect(b).toMatchObject({ reachedSubstrateOwner: true, booted: [{ workspaceId: 'ws1', harnessSlug: 'papercup' }] });
  });
});
