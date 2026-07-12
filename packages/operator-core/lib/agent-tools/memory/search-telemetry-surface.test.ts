/**
 * orient-recall-quality-2026-07-12 P-001 — memory:search records its recall
 * telemetry under the ctx-borne `telemetrySurface` (stamped by a compound's
 * inProcessCall — e.g. coord:orient's fold stamps 'orient'), falling back to
 * 'search' for direct calls. Without this pin, deleting the ctx read silently
 * re-blends orient's recall into generic 'search' and per-entry-point recall
 * quality becomes unmeasurable again (the exact gap this plan closes).
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
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
}));
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercup' }] })),
}));
vi.mock('../../memory/configure', () => ({
  isOpenAiEmbedInCooldown: vi.fn(() => false),
}));
// The telemetry seam under test — both are dynamic imports inside the handler's
// fire-and-forget, so the mocks intercept the deferred write.
const recordRecallStatsMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../memory/recall-stats', () => ({ recordRecallStats: recordRecallStatsMock }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));

import search from './search';
import { getMemoryBackend } from '../../memory/backend';

const oneHitBackend = () => ({
  name: 'one-hit',
  available: vi.fn(async () => ({ ok: true })),
  search: vi.fn(async () => [{ id: 'm1', text: 'a relevant memory', scope: 'user', score: 0.8 }]),
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
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({ surface: 'search' });
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
