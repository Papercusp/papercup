/**
 * dogfood_substrate_status.test.ts — the dev:dogfood_substrate_status HANDLER (the
 * substrate composer + the PG claim-stat loader are mocked). The genuine handler logic is
 * the TWO-PASS refresh: pass 1 composes a PG-free status; if any harness booted, it loads
 * real claim stats per harness and RE-derives the status with those stats keyed by
 * workspace::slug. Pins: the empty-harness short-circuit (no PG load), and that the real
 * stats reach the second-pass resolveClaimStats (the verdict reflects real error rates).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/dogfood_substrate_status.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../sync/hyperbee/in-process-status', () => ({ getInProcessSubstrateStatus: vi.fn() }));
vi.mock('../../orchestrator/load-claim-attempts', () => ({ loadClaimAttemptStats: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: { unsafe: vi.fn(async () => []) } })),
}));

import { getInProcessSubstrateStatus } from '../../sync/hyperbee/in-process-status';
import { loadClaimAttemptStats } from '../../orchestrator/load-claim-attempts';
const statusM = vi.mocked(getInProcessSubstrateStatus);
const statsM = vi.mocked(loadClaimAttemptStats);
const tool = (await import('./dogfood_substrate_status')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const run = () => tool.handler({} as never, {} as never) as Promise<Out>;

beforeEach(() => vi.clearAllMocks());

describe('dev:dogfood_substrate_status handler', () => {
  it('short-circuits when no harness booted (no PG claim-stat load)', async () => {
    statusM.mockReturnValue({ harnesses: [], summary: { ok: true } } as never);
    const b = body(await run());
    expect(b).toMatchObject({ harnesses: [], summary: { ok: true } });
    expect(statsM).not.toHaveBeenCalled();
  });

  it('refreshes the verdict with real per-harness claim stats (two-pass)', async () => {
    // The composer echoes whatever resolveClaimStats returns for ws::web, so we can
    // observe which stats reached each pass.
    statusM.mockImplementation((opts: { resolveClaimStats: (w: string, s: string) => unknown }) => ({
      harnesses: [{ workspaceId: 'ws', harnessSlug: 'web' }],
      probe: opts.resolveClaimStats('ws', 'web'),
    }) as never);
    statsM.mockResolvedValue({ total: 10, won: 8, lost: 1, error: 1 } as never);

    const b = body(await run());
    expect(statsM).toHaveBeenCalledTimes(1);
    expect(statsM.mock.calls[0]![0]).toMatchObject({ workspace_id: 'ws', harness_slug: 'web' });
    // the RETURNED status is the second pass, whose resolveClaimStats yields the real stats
    expect(b.probe).toMatchObject({ total: 10, won: 8, error: 1 });
  });

  it('tolerates a claim-stat load failure (falls back to zeroed stats)', async () => {
    statusM.mockImplementation((opts: { resolveClaimStats: (w: string, s: string) => unknown }) => ({
      harnesses: [{ workspaceId: 'ws', harnessSlug: 'web' }],
      probe: opts.resolveClaimStats('ws', 'web'),
    }) as never);
    statsM.mockRejectedValue(new Error('pg down'));
    const b = body(await run());
    expect(b.probe).toMatchObject({ total: 0, won: 0, lost: 0, error: 0 });
  });
});
