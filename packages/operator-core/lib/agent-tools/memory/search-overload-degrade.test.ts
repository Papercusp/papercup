/**
 * WI-4214 (memory-public-release-hardening-2026-07-11 P-005) — memory:search
 * overload degrade. An UP-BUT-SATURATED embedder (the 2026-07-11 sidecar
 * incident shape: healthz green, every embed multi-second) times the semantic
 * leg out; before this fix the caller got a bare
 * `{ ok:false, reason:'memory_timeout', results:[] }` — no degraded marker
 * (an agent reads the [] as "nothing relevant exists") and no fallback. The
 * contract now: EVERY failed/reduced recall is stamped `degraded:true`, and a
 * backend advertising the embed-free `searchLexical` capability serves token
 * -match hits (stamped `fallback:'lexical'`) instead of nothing.
 *
 * Fault injection: PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS shrunk to ~30ms + a
 * never-resolving `search` simulates the saturated embedder; the lexical leg
 * answers fast (it is a plain PG token query — no embedder on its path).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/search-overload-degrade.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

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

import search from './search';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
import { resetMemoryDegradedForTest } from '../../memory/op-deadline';

const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});

/** One lexical hit in the neutral entry shape the fallback returns. */
const LEX_HIT = {
  id: 'lex-1',
  text: 'embed sidecar concurrency knob lives in embed-sidecar-server.ts',
  kind: 'project',
  scope: 'user-1',
  score: 0.5,
  metadata: { kind: 'project' },
};

/** Saturated-embedder simulation: available() is green (the store is up),
 *  search() never resolves (every embed is stuck in the queue). */
const saturatedBackend = (withLexical: boolean) => ({
  name: 'saturated',
  available: vi.fn(async () => ({ ok: true })),
  search: vi.fn(() => NEVER<unknown[]>()),
  ...(withLexical ? { searchLexical: vi.fn(async () => [LEX_HIT]) } : {}),
  list: vi.fn(async () => [] as unknown[]),
  get: vi.fn(async () => null),
  remember: vi.fn(async () => ({ ids: [] })),
  update: vi.fn(async () => {}),
  forget: vi.fn(async () => {}),
});

const useBackend = (b: { name: string }): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

const ctx = { principal: { workspaceId: 'ws-test' } } as never;
const parse = (
  res: unknown,
): {
  ok: boolean;
  reason?: string;
  degraded?: boolean;
  degraded_reason?: string;
  fallback?: string;
  results?: Array<{ id: string; memory: string }>;
} => {
  const r = res as { data?: never; content?: Array<{ text: string }> };
  return r.data ?? JSON.parse(r.content![0].text);
};

beforeAll(() => {
  process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = '30';
});
afterAll(() => {
  delete process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
  delete process.env.PAPERCUSP_MEMORY_LEXICAL_FALLBACK_TIMEOUT_MS;
});
beforeEach(() => {
  resetMemoryDegradedForTest();
  delete process.env.PAPERCUSP_MEMORY_LEXICAL_FALLBACK_TIMEOUT_MS;
});

describe('memory:search overload degrade (WI-4214)', () => {
  it('a saturated semantic leg + searchLexical capability → lexical hits, stamped degraded + fallback', async () => {
    const backend = saturatedBackend(true);
    useBackend(backend);
    const out = parse(await search.handler({ query: 'embed sidecar concurrency' }, ctx));
    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(true);
    expect(out.degraded_reason).toBe('memory_timeout');
    expect(out.fallback).toBe('lexical');
    expect(out.results?.map((r) => r.id)).toEqual(['lex-1']);
    // The wire row keeps the byte-stable shape (text lands as `memory`).
    expect(out.results?.[0].memory).toBe(LEX_HIT.text);
    // The fallback ran with the SAME scopes the semantic leg used.
    const lexArgs = backend.searchLexical!.mock.calls[0];
    expect(lexArgs[0]).toBe('embed sidecar concurrency');
    expect((lexArgs[1] as { scope: string[] }).scope).toEqual(['user-1', 'harness:papercup']);
  });

  it('a saturated semantic leg WITHOUT the capability → honest empty, degraded:true (never a silent miss)', async () => {
    useBackend(saturatedBackend(false));
    expect(parse(await search.handler({ query: 'q' }, ctx))).toEqual({
      ok: false,
      reason: 'memory_timeout',
      degraded: true,
      results: [],
    });
  });

  it('a dead sidecar (sidecar_required_unavailable throw) also rides the lexical fallback with its classified reason', async () => {
    const backend = saturatedBackend(true);
    backend.search = vi.fn(async () => {
      throw new Error('sidecar_required_unavailable: embed sidecar http://127.0.0.1:3384 unreachable');
    });
    useBackend(backend);
    const out = parse(await search.handler({ query: 'embed sidecar concurrency' }, ctx));
    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(true);
    expect(out.degraded_reason).toBe('sidecar_unavailable');
    expect(out.fallback).toBe('lexical');
    expect(out.results?.map((r) => r.id)).toEqual(['lex-1']);
  });

  it('a mid-flight MemoryUnavailableError maps to its clean reason + degraded (was an opaque handler_error)', async () => {
    const backend = saturatedBackend(false);
    backend.search = vi.fn(async () => {
      throw new MemoryUnavailableError('mem0_unavailable');
    });
    useBackend(backend);
    expect(parse(await search.handler({ query: 'q' }, ctx))).toEqual({
      ok: false,
      reason: 'mem0_unavailable',
      degraded: true,
      results: [],
    });
  });

  it('a down store (available() → ok:false) is stamped degraded too', async () => {
    const backend = saturatedBackend(false);
    backend.available = vi.fn(async () => ({ ok: false, reason: 'mem0_unavailable' }) as { ok: boolean });
    useBackend(backend);
    expect(parse(await search.handler({ query: 'q' }, ctx))).toEqual({
      ok: false,
      reason: 'mem0_unavailable',
      degraded: true,
      results: [],
    });
  });

  it('a fallback that ITSELF hangs is bounded by its own deadline → honest empty envelope', async () => {
    process.env.PAPERCUSP_MEMORY_LEXICAL_FALLBACK_TIMEOUT_MS = '30';
    const backend = saturatedBackend(true);
    backend.searchLexical = vi.fn(() => NEVER<never[]>());
    useBackend(backend);
    expect(parse(await search.handler({ query: 'q' }, ctx))).toEqual({
      ok: false,
      reason: 'memory_timeout',
      degraded: true,
      results: [],
    });
  });

  it('a HEALTHY search never consults the fallback and carries no degraded stamp', async () => {
    const backend = saturatedBackend(true);
    backend.search = vi.fn(async () => [LEX_HIT]);
    useBackend(backend);
    const out = parse(await search.handler({ query: 'q' }, ctx));
    expect(out.ok).toBe(true);
    expect('degraded' in out).toBe(false);
    expect('fallback' in out).toBe(false);
    expect(backend.searchLexical).not.toHaveBeenCalled();
  });
});
