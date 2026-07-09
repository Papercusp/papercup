/**
 * federation-status.test.ts — GET /api/discovery/federation-status (Brief M / G-004).
 *
 * The desktop's first live federation-status read. Verifies it (a) projects each
 * owned hive's HONEST announce-topic reach (reachablePeersForHive) — 0 for a
 * private hive, the real count for an announced one — (b) composes the install
 * substrate summary from the verdicts, and (c) gates non-loopback callers.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// --- mock the route's external seams (PG read / boot wire / in-process trackers) ---
const M = vi.hoisted(() => ({
  listOwnedHiveMeta: vi.fn(),
  getInProcessSubstrateStatus: vi.fn(),
  ensureHiveDirectoryWired: vi.fn(async () => null),
  // EI-1618/EI-1599: the substrate-outbox drain read goes through getOrgPg().sql.unsafe.
  sqlUnsafe: vi.fn(async () => [] as unknown[]),
  getOrgPg: vi.fn(() => ({ sql: { unsafe: M.sqlUnsafe } })),
}));
const { listOwnedHiveMeta, getInProcessSubstrateStatus, ensureHiveDirectoryWired } = M;

// Partial mock — keep every real export (other transitive imports use `generated`
// etc.), override only getOrgPg with our fake sql.unsafe.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: M.getOrgPg };
});
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../hive-directory-meta', () => ({ listOwnedHiveMeta: M.listOwnedHiveMeta }));
vi.mock('../../../sync/hyperbee/in-process-status', () => ({
  getInProcessSubstrateStatus: M.getInProcessSubstrateStatus,
}));
vi.mock('../../../hive-directory-boot', () => ({ ensureHiveDirectoryWired: M.ensureHiveDirectoryWired }));
// WI-899 added substrate.sidecarLive, resolved from probeSubstrateSidecar(). Unmocked, its
// value depends on whether a SUBSTRATE_SIDECAR is reachable on the HOST — env-dependent, so it
// flakes on the dev box (where sidecars run) vs a clean CI box. Pin sidecar mode OFF (present:false
// → sidecarLive:null) so the shape assertion below is hermetic.
vi.mock('../../../service-health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../service-health')>();
  return { ...actual, probeSubstrateSidecar: vi.fn(async () => ({ present: false, up: false })) };
});

import statusRoute from './federation-status';
import {
  configureHiveDirectoryForTest,
  __resetHiveDirectorySingleton,
} from '../../../hive-directory-deps';
import type { HiveDirectoryDeps } from '../../../hive-directory';

const NOW = 1_700_000_000_000;

/** Fake deps whose `reachablePeers` seam returns a fixed count for ANY topic —
 *  so a registered public/invite owned hive resolves a real reach. */
const fakeDeps = (reach: number): HiveDirectoryDeps => ({
  sign: async (b) => Buffer.from(b),
  verifyAttestation: async () => true,
  broadcast: async () => {},
  reachablePeers: () => reach,
  now: () => NOW,
});

const ownedDesc = (over: Record<string, unknown> = {}) => ({
  potId: 'pub',
  title: 'Pub',
  description: 'd',
  memberTopics: ['a'.repeat(64)],
  visibility: 'public' as const,
  createdAt: NOW,
  ownerGithubLogin: 'me',
  ownerGithubUserId: 1,
  ownerDevicePubkey: 'x',
  attestationGistId: 'g',
  ...over,
});

const call = async (url: string) => {
  const res = (await statusRoute.handler(new Request(url) as never, {} as never)) as Response;
  return { status: res.status, body: await res.json().catch(() => null) };
};

beforeEach(() => {
  listOwnedHiveMeta.mockReset();
  getInProcessSubstrateStatus.mockReset();
  ensureHiveDirectoryWired.mockClear();
  M.sqlUnsafe.mockReset();
  M.sqlUnsafe.mockResolvedValue([]); // no undrained rows by default
  M.getOrgPg.mockClear();
  getInProcessSubstrateStatus.mockReturnValue({
    substrateActive: true,
    bootedCount: 2,
    summary: {},
    harnesses: [
      { workspaceId: 'ws-test', harnessSlug: 'a', verdict: 'healthy', reasons: [] },
      { workspaceId: 'ws-test', harnessSlug: 'b', verdict: 'degraded', reasons: ['x'] },
    ],
    logStats: [],
  });
});

afterEach(() => {
  __resetHiveDirectorySingleton();
  vi.restoreAllMocks();
});

describe('GET /api/discovery/federation-status (G-004)', () => {
  it('reports each owned hive\'s real announce-topic reach + the substrate summary', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps(3));
    dir.registerLocalHive(ownedDesc());
    listOwnedHiveMeta.mockResolvedValue([
      { potId: 'pub', title: 'Pub', description: 'd', visibility: 'public', memberTopics: ['t'], createdAt: NOW },
    ]);

    const { status, body } = await call('http://127.0.0.1/api/discovery/federation-status');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.hives).toEqual([
      { potId: 'pub', title: 'Pub', visibility: 'public', memberCount: 1, reachablePeers: 3 },
    ]);
    expect(body.substrate).toEqual({
      active: true,
      bootedHarnesses: 2,
      healthy: 1,
      booting: 0,
      degraded: 1,
      // no undrained outbox rows (default sqlUnsafe → []) → honest zero-drain
      drain: { stalledHarnesses: 0, worstUndrainedCount: 0, worstOldestUndrainedAgeMs: null },
      // WI-899 (A): SUBSTRATE_SIDECAR liveness — sidecar mode off in this test (mocked
      // probeSubstrateSidecar → present:false) → null (nothing to probe).
      sidecarLive: null,
    });
  });

  it('reports reachablePeers:0 for a private hive — it never announces (no fake reach)', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps(5)); // seam would return 5 if asked
    dir.registerLocalHive(ownedDesc({ potId: 'priv', visibility: 'private' }));
    listOwnedHiveMeta.mockResolvedValue([
      { potId: 'priv', title: 'Secret', description: 'd', visibility: 'private', memberTopics: [], createdAt: NOW },
    ]);

    const { body } = await call('http://127.0.0.1/api/discovery/federation-status');
    expect(body.hives).toEqual([
      { potId: 'priv', title: 'Secret', visibility: 'private', memberCount: 0, reachablePeers: 0 },
    ]);
  });

  it('returns an empty hive list (still ok) when this workspace owns no hives', async () => {
    configureHiveDirectoryForTest(fakeDeps(0));
    listOwnedHiveMeta.mockResolvedValue([]);
    const { status, body } = await call('http://localhost/api/discovery/federation-status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, hives: [] });
  });

  it('wires the substrate-outbox drain read into the verdict resolver (EI-1618)', async () => {
    configureHiveDirectoryForTest(fakeDeps(0));
    listOwnedHiveMeta.mockResolvedValue([]);
    // one harness with 2 rows captured ~2m ago, still undrained
    const oldTs = Date.now() - 120_000;
    M.sqlUnsafe.mockResolvedValue([
      { workspace_id: 'ws-test', harness_slug: 'a', undrained: '2', oldest_ts: String(oldTs) },
    ]);

    await call('http://127.0.0.1/api/discovery/federation-status');

    // the route passed a resolveDrainStats fn that reads the prefetched stats
    const opts = getInProcessSubstrateStatus.mock.calls.at(-1)?.[0] as
      | {
          resolveDrainStats?: (
            ws: string,
            slug: string,
          ) => { undrainedCount: number; oldestUndrainedAgeMs: number | null };
        }
      | undefined;
    expect(typeof opts?.resolveDrainStats).toBe('function');
    const stat = opts!.resolveDrainStats!('ws-test', 'a');
    expect(stat.undrainedCount).toBe(2);
    expect(stat.oldestUndrainedAgeMs).toBeGreaterThanOrEqual(119_000);
    // a harness with no undrained rows resolves to honest zero
    expect(opts!.resolveDrainStats!('ws-test', 'other')).toEqual({
      undrainedCount: 0,
      oldestUndrainedAgeMs: null,
    });
  });

  it('rolls stalled harnesses into substrate.drain (the honest install-wide sync signal)', async () => {
    configureHiveDirectoryForTest(fakeDeps(0));
    listOwnedHiveMeta.mockResolvedValue([]);
    getInProcessSubstrateStatus.mockReturnValue({
      substrateActive: true,
      bootedCount: 3,
      summary: {},
      harnesses: [
        { workspaceId: 'ws-test', harnessSlug: 'clean', verdict: 'healthy', reasons: [], drain: { undrainedCount: 0, oldestUndrainedAgeMs: null } },
        { workspaceId: 'ws-test', harnessSlug: 'lag', verdict: 'degraded', reasons: ['x'], drain: { undrainedCount: 4, oldestUndrainedAgeMs: 90_000 } },
        { workspaceId: 'ws-test', harnessSlug: 'stall', verdict: 'unhealthy', reasons: ['y'], drain: { undrainedCount: 12, oldestUndrainedAgeMs: 600_000 } },
      ],
      logStats: [],
    });

    const { body } = await call('http://127.0.0.1/api/discovery/federation-status');
    expect(body.substrate.drain).toEqual({
      stalledHarnesses: 2, // 'lag' (90s ≥ 60s) + 'stall' (600s); 'clean' excluded
      worstUndrainedCount: 12,
      worstOldestUndrainedAgeMs: 600_000,
    });
  });

  it('does NOT flag a harness with a few briefly-undrained rows (< 60s) as stalled', async () => {
    configureHiveDirectoryForTest(fakeDeps(0));
    listOwnedHiveMeta.mockResolvedValue([]);
    getInProcessSubstrateStatus.mockReturnValue({
      substrateActive: true,
      bootedCount: 1,
      summary: {},
      harnesses: [
        { workspaceId: 'ws-test', harnessSlug: 'fresh', verdict: 'healthy', reasons: [], drain: { undrainedCount: 3, oldestUndrainedAgeMs: 5_000 } },
      ],
      logStats: [],
    });
    const { body } = await call('http://127.0.0.1/api/discovery/federation-status');
    expect(body.substrate.drain.stalledHarnesses).toBe(0);
  });

  it('declares the loopback tier (auth-tier Wave 1) — 403s a non-loopback caller', async () => {
    expect((statusRoute as { auth?: unknown }).auth).toBe('loopback');
    const { Hono } = await import('hono');
    const { registerRoute } = await import('../../define-route');
    const app = new Hono();
    registerRoute(app, statusRoute as never);
    configureHiveDirectoryForTest(fakeDeps(0));
    listOwnedHiveMeta.mockResolvedValue([]);
    const res = await app.request('http://evil.example.com/discovery/federation-status');
    expect(res.status).toBe(403);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    expect(body?.error).toBe('loopback_only');
  });
});
