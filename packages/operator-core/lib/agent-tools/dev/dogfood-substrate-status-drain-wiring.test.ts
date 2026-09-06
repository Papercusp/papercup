/**
 * dogfood-substrate-status-drain-wiring.test.ts — WI-37387 recurrence guard.
 *
 * `dev:dogfood_substrate_status` composes its verdict from injectable resolvers on
 * `getInProcessSubstrateStatus`. The `resolveDrainStats` seam DEFAULTS to zero-drain
 * (the composer module is pure/PG-free), and per its own doc-comment it "is what flips
 * a stuck (captured-but-not-federating) harness off 'healthy'".
 *
 * The tool shipped without wiring it at any of its four call sites, so `undrainedCount`
 * was a hardcoded 0 and the drain leg of the verdict could never fire — every harness
 * read "healthy / no issues detected" regardless of the real backlog (measured live:
 * papercusp at 34,491 undrained rows still rendered healthy, while the HTTP route it
 * claims to mirror reported the true number).
 *
 * This is the general failure shape worth guarding: a verdict assembled from injectable
 * resolvers that DEFAULT TO "everything is fine" fails SILENT-GREEN whenever a caller
 * forgets one — there is no error, no missing field, just a permanently reassuring
 * answer. So the assertion below is deliberately not "a function was passed": it checks
 * the resolver returns the REAL prefetched numbers, which a re-defaulted seam cannot do.
 *
 * Mirrors the sibling assertion on the HTTP route (federation-status.test.ts, EI-1618).
 * `load-drain-stats` is intentionally NOT mocked, so this exercises the real
 * query → map → resolver chain through a faked `sql.unsafe`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const M = vi.hoisted(() => ({
  getInProcessSubstrateStatus: vi.fn(),
  sqlUnsafe: vi.fn(async () => [] as unknown[]),
  getOrgPg: vi.fn(() => ({ sql: { unsafe: M.sqlUnsafe } })),
  loadClaimAttemptStats: vi.fn(async () => ({ total: 0, won: 0, lost: 0, error: 0 })),
  getCachedRemoteBootedHandles: vi.fn(() => null),
  getPgBootedHandlesSnapshotFallback: vi.fn(async () => null),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: M.getOrgPg };
});
vi.mock('../../sync/hyperbee/in-process-status', () => ({
  getInProcessSubstrateStatus: M.getInProcessSubstrateStatus,
}));
vi.mock('../../orchestrator/load-claim-attempts', () => ({
  loadClaimAttemptStats: M.loadClaimAttemptStats,
}));
vi.mock('../../sync/hyperbee/cluster-booted-handles-sync', () => ({
  getCachedRemoteBootedHandles: M.getCachedRemoteBootedHandles,
  collectHarnessContentConnectivity: vi.fn(() => []),
}));
vi.mock('../../sync/hyperbee/substrate-booted-handles-pg', () => ({
  getPgBootedHandlesSnapshotFallback: M.getPgBootedHandlesSnapshotFallback,
}));

import tool from './dogfood_substrate_status';

type DrainStat = { undrainedCount: number; oldestUndrainedAgeMs: number | null };
type ComposerOpts = { resolveDrainStats?: (ws: string, slug: string) => DrainStat };

const lastOpts = (): ComposerOpts | undefined =>
  M.getInProcessSubstrateStatus.mock.calls.at(-1)?.[0] as ComposerOpts | undefined;

/** Every composer call the handler made — the guard must hold for ALL of them, not
 *  just the last, since any single un-wired site re-introduces the silent green. */
const allOpts = (): ComposerOpts[] =>
  M.getInProcessSubstrateStatus.mock.calls.map((c) => c[0] as ComposerOpts);

describe('dev:dogfood_substrate_status — drain-stats wiring (WI-37387)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    M.getInProcessSubstrateStatus.mockReturnValue({
      reachedSubstrateOwner: true,
      harnesses: [{ workspaceId: 'ws-test', harnessSlug: 'a' }],
    });
  });

  it('resolves the REAL undrained backlog, not the zero-drain default', async () => {
    const oldTs = Date.now() - 120_000; // 2 rows captured ~2m ago, still undrained
    M.sqlUnsafe.mockResolvedValue([
      {
        workspace_id: 'ws-test',
        harness_slug: 'a',
        undrained: '2',
        oldest_enqueued_at_ms: String(oldTs),
      },
    ]);

    await tool.handler({} as never, {} as never);

    const opts = lastOpts();
    expect(typeof opts?.resolveDrainStats).toBe('function');
    const stat = opts!.resolveDrainStats!('ws-test', 'a');
    // The load-bearing assertion: a re-defaulted seam yields 0 here, so this is what
    // actually fails if the wiring is dropped again.
    expect(stat.undrainedCount).toBe(2);
    expect(stat.oldestUndrainedAgeMs).toBeGreaterThanOrEqual(119_000);
  });

  it('wires the resolver at EVERY composer call site, not just the last', async () => {
    M.sqlUnsafe.mockResolvedValue([
      {
        workspace_id: 'ws-test',
        harness_slug: 'a',
        undrained: '7',
        oldest_enqueued_at_ms: String(Date.now()),
      },
    ]);

    await tool.handler({} as never, {} as never);

    const calls = allOpts();
    expect(calls.length).toBeGreaterThan(0);
    for (const opts of calls) {
      expect(typeof opts.resolveDrainStats).toBe('function');
      expect(opts.resolveDrainStats!('ws-test', 'a').undrainedCount).toBe(7);
    }
  });

  it('scopes by workspace AND slug — substrate_outbox is multi-tenant', async () => {
    // The same slug lives under two workspaces on the live box (papercusp is booted
    // under both `papercusp-workspace` and `default`), so a slug-only lookup would
    // silently mix tenants and report one workspace's backlog for the other.
    M.sqlUnsafe.mockResolvedValue([
      { workspace_id: 'ws-one', harness_slug: 'shared', undrained: '5', oldest_ts: String(Date.now()) },
      { workspace_id: 'ws-two', harness_slug: 'shared', undrained: '11', oldest_ts: String(Date.now()) },
    ]);

    await tool.handler({} as never, {} as never);

    const resolve = lastOpts()!.resolveDrainStats!;
    expect(resolve('ws-one', 'shared').undrainedCount).toBe(5);
    expect(resolve('ws-two', 'shared').undrainedCount).toBe(11);
  });

  it('degrades to honest zero-drain for a harness with no undrained rows', async () => {
    M.sqlUnsafe.mockResolvedValue([]);

    await tool.handler({} as never, {} as never);

    expect(lastOpts()!.resolveDrainStats!('ws-test', 'nothing-here')).toEqual({
      undrainedCount: 0,
      oldestUndrainedAgeMs: null,
    });
  });

  it('still answers when the drain read throws — a diagnostic must not fail closed', async () => {
    M.sqlUnsafe.mockRejectedValue(new Error('relation "substrate_outbox" does not exist'));

    await expect(tool.handler({} as never, {} as never)).resolves.toBeDefined();
    expect(lastOpts()!.resolveDrainStats!('ws-test', 'a')).toEqual({
      undrainedCount: 0,
      oldestUndrainedAgeMs: null,
    });
  });
});
