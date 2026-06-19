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
}));
const { listOwnedHiveMeta, getInProcessSubstrateStatus, ensureHiveDirectoryWired } = M;

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../hive-directory-meta', () => ({ listOwnedHiveMeta: M.listOwnedHiveMeta }));
vi.mock('../../../sync/hyperbee/in-process-status', () => ({
  getInProcessSubstrateStatus: M.getInProcessSubstrateStatus,
}));
vi.mock('../../../hive-directory-boot', () => ({ ensureHiveDirectoryWired: M.ensureHiveDirectoryWired }));

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
  hiveId: 'pub',
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
      { hiveId: 'pub', title: 'Pub', description: 'd', visibility: 'public', memberTopics: ['t'], createdAt: NOW },
    ]);

    const { status, body } = await call('http://127.0.0.1/api/discovery/federation-status');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.hives).toEqual([
      { hiveId: 'pub', title: 'Pub', visibility: 'public', memberCount: 1, reachablePeers: 3 },
    ]);
    expect(body.substrate).toEqual({ active: true, bootedHarnesses: 2, healthy: 1, booting: 0, degraded: 1 });
  });

  it('reports reachablePeers:0 for a private hive — it never announces (no fake reach)', async () => {
    const dir = configureHiveDirectoryForTest(fakeDeps(5)); // seam would return 5 if asked
    dir.registerLocalHive(ownedDesc({ hiveId: 'priv', visibility: 'private' }));
    listOwnedHiveMeta.mockResolvedValue([
      { hiveId: 'priv', title: 'Secret', description: 'd', visibility: 'private', memberTopics: [], createdAt: NOW },
    ]);

    const { body } = await call('http://127.0.0.1/api/discovery/federation-status');
    expect(body.hives).toEqual([
      { hiveId: 'priv', title: 'Secret', visibility: 'private', memberCount: 0, reachablePeers: 0 },
    ]);
  });

  it('returns an empty hive list (still ok) when this workspace owns no hives', async () => {
    configureHiveDirectoryForTest(fakeDeps(0));
    listOwnedHiveMeta.mockResolvedValue([]);
    const { status, body } = await call('http://localhost/api/discovery/federation-status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, hives: [] });
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
