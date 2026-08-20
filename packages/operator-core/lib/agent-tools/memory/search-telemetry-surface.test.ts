/**
 * orient-recall-quality-2026-07-12 P-001 — memory:search records its recall
 * telemetry under the ctx-borne `telemetrySurface` (stamped by a compound's
 * inProcessCall — e.g. coord:orient's fold stamps 'orient'), falling back to
 * 'search' for direct calls.
 *
 * ⚠ SCOPE — READ THIS BEFORE TRUSTING THIS FILE (WI-4549). These cases call
 * `search.handler(input, ctxLiteral)` DIRECTLY, so they pin only that the handler
 * READS `ctx.telemetrySurface`. They CANNOT pin that dispatch DELIVERS it, and the
 * docstring here used to claim they closed the whole gap. They did not: memory:search
 * is principal-gated, defineTool's legacy shim rebuilt the handler ctx from an
 * allowlist that dropped the stamp, and orient recorded ZERO rows in
 * memory_recall_stats for WEEKS — blended into generic 'search' — while this suite
 * stayed green. A ctx-borne field has two halves (read + delivery); a handler-level
 * test can only ever pin one.
 *
 * The DELIVERY half is pinned where it actually breaks — at the dispatch boundary:
 * libs/generic/tooldef/src/define-tool-legacy-ctx.test.ts ("telemetrySurface
 * threading (WI-4549)"), which drives the real dispatchProjectedTool path. If you
 * add a ctx-borne field, pin it THERE, not here.
 *
 * Mock scaffold mirrors search-degraded.test.ts (drives the REAL handler with a
 * mocked backend); recordRecallStats + db-org are mocked because the telemetry
 * write is a fire-and-forget dynamic import.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/search-telemetry-surface.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {
    constructor(public readonly reason: string) {
      super(`memory backend unavailable: ${reason}`);
      this.name = 'MemoryUnavailableError';
    }
  },
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
// Spread the REAL module and override only defineTool: a hand-listed factory
// strands every export the tool graph later starts importing — AGENT_ROLES did
// exactly that (testing/run.ts), breaking collection across this directory.
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercup' }] })),
  // EI-9039: p2p/revocation-reaper top-level-imports this export and is reached
  // transitively from the subject, so it resolves against THIS partial mock.
  // Unrelated to telemetry — a stub purely to keep collection alive.
  deregisterEphemeralForeignHarness: vi.fn(async () => false),
}));
vi.mock('../../memory/configure', () => ({
  isOpenAiEmbedInCooldown: vi.fn(() => false),
}));
// The telemetry seam under test — both are dynamic imports inside the handler's
// fire-and-forget, so the mocks intercept the deferred write.
const recordRecallStatsMock = vi.hoisted(() => vi.fn(async (_sql: unknown, _input: unknown) => {}));
vi.mock('../../memory/recall-stats', () => ({ recordRecallStats: recordRecallStatsMock }));
// Spread-original: search.ts's import chain reaches desktop-health.ts, which reads
// db-org's `generated` schema at module scope — a bare `{ getOrgPg }` mock breaks
// that load. Only getOrgPg is stubbed.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));

import search from './search';
import { getMemoryBackend, type SearchLegStats, type SearchOptions } from '../../memory/backend';

const LEG_STATS: SearchLegStats = {
  mode: 'floored-union',
  cosine: { ran: true, candidates: 1, qualifying: 1, depth: 5, durationMs: 12.5 },
  lexical: { ran: true, candidates: 2, qualifying: 1, depth: 15, durationMs: 8.25 },
  fused: 1,
  fusionMs: 0.5,
  totalMs: 13.25,
};

const oneHitBackend = () => ({
  name: 'one-hit',
  available: vi.fn(async () => ({ ok: true })),
  search: vi.fn(async (_query: string, opts: SearchOptions) => {
    opts.onLegStats?.(LEG_STATS);
    return [{ id: 'm1', text: 'a relevant memory', scope: 'user', score: 0.8 }];
  }),
  list: vi.fn(async () => [] as unknown[]),
  get: vi.fn(async () => null),
  remember: vi.fn(async () => ({ ids: [] })),
  update: vi.fn(async () => {}),
  forget: vi.fn(async () => {}),
});

/** Flush the handler's fire-and-forget telemetry IIFE. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMemoryBackend).mockReturnValue(oneHitBackend() as unknown as ReturnType<typeof getMemoryBackend>);
});

describe('memory:search recall-telemetry surface (P-001)', () => {
  it("a direct call records under surface 'search' (unchanged default)", async () => {
    await search.handler({ query: 'anything relevant' } as never, { principal: { workspaceId: 'ws-test' } } as never);
    await flush();
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({ surface: 'search', legs: LEG_STATS });
  });

  it("a compound-stamped ctx (telemetrySurface:'orient') records under 'orient'", async () => {
    await search.handler(
      { query: 'anything relevant' } as never,
      { principal: { workspaceId: 'ws-test' }, telemetrySurface: 'orient' } as never,
    );
    await flush();
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({ surface: 'orient' });
  });
});
