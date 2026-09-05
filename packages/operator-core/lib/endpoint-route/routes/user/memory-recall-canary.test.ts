/**
 * memory-recall-canary.test.ts — EI-10368: the latest live recall-canary
 * verdict rides the GET /user/memory/backend envelope so Settings → Memory
 * can render a persistent "Recall health" line (before this, the canary's
 * only human-reaching output was the transient degraded-edge push).
 *
 * The load-bearing cases: the envelope carries the snapshot when the canary
 * has run, carries `recallCanary: null` (not an error) when it hasn't or the
 * read fails, and the route survives even a loader that rejects outright.
 *
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/user/memory-recall-canary.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def }));
vi.mock('../../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('../../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  registeredMemoryBackends: vi.fn(() => ['mem0']),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {},
}));
// Spread the real module: memory/configure.ts calls `initMemoryBackendSelection()`
// at module scope, so a bare factory strands this file at collection. The init is
// overridden with a no-op so no PG I/O runs under the unit test.
vi.mock('../../../memory/backend-selection', async (orig) => ({
  ...(await orig<typeof import('../../../memory/backend-selection')>()),
  currentMemoryBackendChoice: vi.fn(() => 'mem0'),
  writeMemoryBackendChoice: vi.fn(async () => {}),
  initMemoryBackendSelection: vi.fn(async () => {}),
}));
vi.mock('../../../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => 'journal-1'),
  markJournalCommitted: vi.fn(async () => {}),
}));
vi.mock('../../../memory/list-user-memories', () => ({ listUserMemories: vi.fn(async () => []) }));
vi.mock('../../../memory/feedback', () => ({ recordFeedback: vi.fn(async () => {}) }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../../harness-registry', async (orig) => ({
  ...(await orig<typeof import('../../../harness-registry')>()), loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) }));
vi.mock('../../../memory/memory-pause', () => ({
  isMemoryPaused: vi.fn(async () => false),
  setMemoryPaused: vi.fn(async (_u: string, p: boolean) => p),
}));
vi.mock('../../../memory/recall-canary-envelope', () => ({
  recallCanaryForEnvelope: vi.fn(async () => null),
}));

import routes from './memory';
import { getMemoryBackend } from '../../../memory/backend';
import { recallCanaryForEnvelope } from '../../../memory/recall-canary-envelope';

type Route = { method: string; path: string; handler: (req: Request) => Promise<Response> };
const backendInfo = (routes as unknown as Route[]).find(
  (r) => r.method === 'GET' && r.path === '/user/memory/backend',
)!;

const req = (): Request => new Request('http://localhost/api/user/memory/backend', { method: 'GET' });

const okRun = {
  ranAt: '2026-07-12T05:45:00.000Z',
  setVersion: 1,
  backend: 'mem0',
  pairsTotal: 20,
  pairsScored: 19,
  pairsMissing: 1,
  hits: 17,
  rAt10: 0.89,
  baselineRAt10: 0.9,
  delta: -0.01,
  zeroHitRate: 0,
  // EI-10666: zeroHitRate is consumer-level now; the retrieval-level pair localises a blackout.
  retrievalZeroHitRate: 0,
  retrievalRAt10: 0.89,
  latencyP50Ms: 120,
  status: 'ok' as const,
  notes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recallCanaryForEnvelope).mockResolvedValue(null);
  vi.mocked(getMemoryBackend).mockReturnValue({
    name: 'fake',
    available: vi.fn(async () => ({ ok: true })),
  } as unknown as ReturnType<typeof getMemoryBackend>);
});

describe('GET /user/memory/backend — recall-canary snapshot on the envelope (EI-10368)', () => {
  it('carries the latest canary verdict when the canary has run', async () => {
    vi.mocked(recallCanaryForEnvelope).mockResolvedValue({ latest: okRun, trend: [okRun], runCount: 12 });
    const res = await backendInfo.handler(req());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.recallCanary).toMatchObject({
      latest: { status: 'ok', rAt10: 0.89, baselineRAt10: 0.9, ranAt: okRun.ranAt },
      runCount: 12,
    });
  });

  it('carries recallCanary: null (a 200, not an error) when the canary has not run', async () => {
    const res = await backendInfo.handler(req());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.recallCanary).toBeNull();
    // The rest of the envelope is untouched by the canary leg.
    expect(j).toMatchObject({ userId: 'user-1', backend: 'fake' });
  });

  it('still serves the envelope when the loader rejects outright (belt-and-braces)', async () => {
    // recallCanaryForEnvelope is fail-open internally; the route guards anyway
    // — a health read must never take the settings envelope down.
    vi.mocked(recallCanaryForEnvelope).mockRejectedValue(new Error('boom'));
    const res = await backendInfo.handler(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ recallCanary: null, userId: 'user-1' });
  });
});
