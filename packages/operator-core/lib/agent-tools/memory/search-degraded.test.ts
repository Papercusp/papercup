/**
 * EI-9031 — memory:search must STAMP `degraded` when the production embedder
 * (OpenAI) is in its post-exhaustion cooldown. In that window the 'auto' cascade
 * has silently fallen back to the local vec table (reduced breadth), so an empty
 * `results` is NOT reliably "nothing relevant exists" — it may be a false miss.
 * Before the fix, the ok:true response was byte-indistinguishable from a genuine
 * empty, corrupting the recall-miss inference for every agent for the whole
 * outage. This test drives the real handler with a HEALTHY backend that returns
 * no hits, toggling the embedder-cooldown seam.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/search-degraded.test.ts
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
// The embedder-cooldown seam — the whole point of this test. search.ts imports
// ONLY isOpenAiEmbedInCooldown from configure, so a minimal mock is safe (the
// real configure/mem0 chain is not otherwise reached — backend is mocked).
vi.mock('../../memory/configure', () => ({
  isOpenAiEmbedInCooldown: vi.fn(() => false),
}));

import search from './search';
import { getMemoryBackend } from '../../memory/backend';
import { isOpenAiEmbedInCooldown } from '../../memory/configure';

/** A healthy backend that finds NO hits (the reported scenario: a specific,
 *  plausibly-matching intent that comes back empty). */
const healthyEmptyBackend = () => ({
  name: 'healthy-empty',
  available: vi.fn(async () => ({ ok: true })),
  search: vi.fn(async () => [] as unknown[]),
  list: vi.fn(async () => [] as unknown[]),
  get: vi.fn(async () => null),
  remember: vi.fn(async () => ({ ids: [] })),
  update: vi.fn(async () => {}),
  forget: vi.fn(async () => {}),
});

const ctx = { principal: { workspaceId: 'ws-test' } } as never;
const parse = (res: unknown): { ok: boolean; degraded?: boolean; degraded_reason?: string; results?: unknown[] } => {
  const r = res as { data?: unknown; content?: Array<{ text: string }> };
  return (r.data as never) ?? JSON.parse(r.content![0].text);
};

beforeEach(() => {
  vi.mocked(getMemoryBackend).mockReturnValue(healthyEmptyBackend() as unknown as ReturnType<typeof getMemoryBackend>);
  vi.mocked(isOpenAiEmbedInCooldown).mockReturnValue(false);
});

describe('memory:search degraded marker (EI-9031)', () => {
  it('a HEALTHY embedder + empty result carries NO degraded marker (a true empty)', async () => {
    const out = parse(await search.handler({ query: 'own-log-fork-guard work' }, ctx));
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
    expect('degraded' in out).toBe(false);
    expect('degraded_reason' in out).toBe(false);
  });

  it('while the embedder is in its post-exhaustion cooldown, an empty result is stamped degraded (a possibly-false miss)', async () => {
    vi.mocked(isOpenAiEmbedInCooldown).mockReturnValue(true);
    const out = parse(await search.handler({ query: 'own-log-fork-guard work' }, ctx));
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.degraded).toBe(true);
    expect(out.degraded_reason).toBe('embedding_backend_degraded');
  });
});
