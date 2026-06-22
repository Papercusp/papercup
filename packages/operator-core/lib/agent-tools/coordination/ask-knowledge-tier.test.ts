/**
 * ask-knowledge-tier — unit coverage for runKnowledgeTier, the knowledge-FIRST
 * gate (D-001) that runs search:semantic + mem0 BEFORE any peer is interrupted.
 *
 * Correctness here prevents needless interrupts: a wrong mem0 scope key misses a
 * previously-captured answer, and bad dedup/ordering surfaces the wrong candidate.
 * IO is injected (sql/backend) or mocked (search/embedder) — no live PG/embedder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  runHybridSearch: vi.fn(),
  buildQueryEmbedder: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'ws-active'),
}));
vi.mock('@papercusp/search', () => ({ runHybridSearch: m.runHybridSearch }));
vi.mock('../search/embedder', () => ({ buildQueryEmbedder: m.buildQueryEmbedder }));
vi.mock('../search/sources', () => ({ SEARCH_SOURCES: [] }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../memory/backend', () => ({ getMemoryBackend: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: m.activeWorkspaceId }));

import { runKnowledgeTier } from './ask-knowledge-tier';
import type { MemoryBackend } from '../../memory/backend';

const SQL = {} as never;
type BackendStub = {
  available: () => Promise<{ ok: boolean }>;
  search: (q: string, opts: { scope: string[]; limit?: number }) => Promise<Array<{ id: string; text: string; score?: number }>>;
};
function fakeBackend(over: Partial<BackendStub> = {}): MemoryBackend {
  return {
    available: vi.fn(async () => ({ ok: true })),
    search: vi.fn(async () => []),
    ...over,
  } as unknown as MemoryBackend;
}

beforeEach(() => {
  m.runHybridSearch.mockReset().mockResolvedValue({ results: [], embedderAvailable: false });
  m.buildQueryEmbedder.mockReset().mockResolvedValue({});
  m.activeWorkspaceId.mockReset().mockReturnValue('ws-active');
});

describe('runKnowledgeTier', () => {
  it('returns search:semantic + mem0 candidates, sorted by score desc, top-N', async () => {
    m.runHybridSearch.mockResolvedValue({
      embedderAvailable: true,
      results: [
        { source: 'escalations', source_id: '1', excerpt: 'esc one', score: 0.9 },
        { source: 'decisions', source_id: '2', excerpt: 'dec two', score: 0.5 },
      ],
    });
    const backend = fakeBackend({ search: vi.fn(async () => [{ id: 'a', text: 'mem a', score: 0.7 }]) });
    const res = await runKnowledgeTier({ query: 'how do locks work', limit: 5 }, { sql: SQL, backend });
    expect(res.embedder_available).toBe(true);
    expect(res.searched).toEqual(['search:semantic', 'mem0']);
    expect(res.candidates.map((c) => c.ref)).toEqual(['escalations:1', 'mem0:a', 'decisions:2']); // 0.9 > 0.7 > 0.5
    expect(res.candidates[1]).toMatchObject({ source: 'mem0', ref: 'mem0:a', label: 'mem0', excerpt: 'mem a', score: 0.7 });
  });

  it('dedupes by ref, keeping the HIGHEST score', async () => {
    m.runHybridSearch.mockResolvedValue({
      embedderAvailable: true,
      results: [
        { source: 'escalations', source_id: '1', excerpt: 'low', score: 0.4 },
        { source: 'escalations', source_id: '1', excerpt: 'high', score: 0.95 },
      ],
    });
    const res = await runKnowledgeTier({ query: 'q' }, { sql: SQL, backend: fakeBackend() });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({ ref: 'escalations:1', score: 0.95, excerpt: 'high' });
  });

  it('reads mem0 under the asker + workspace + harness keys (empty workspaceId → activeWorkspaceId fallback)', async () => {
    const search = vi.fn(async (_q: string, _opts: { scope: string[]; limit?: number }) => [] as Array<{ id: string; text: string; score?: number }>);
    await runKnowledgeTier(
      { query: 'q', asker_id: 'me', harness_slug: 'papercusp', workspaceId: '' },
      { sql: SQL, backend: fakeBackend({ search }) },
    );
    const scope = search.mock.calls[0][1].scope;
    expect(scope).toContain('me');
    expect(scope).toContain('workspace:ws-active'); // empty → activeWorkspaceId()
    expect(scope).toContain('harness:papercusp');
  });

  it('uses the provided workspaceId for the mem0 key when present (no fallback)', async () => {
    const search = vi.fn(async (_q: string, _opts: { scope: string[]; limit?: number }) => [] as Array<{ id: string; text: string; score?: number }>);
    await runKnowledgeTier({ query: 'q', workspaceId: 'ws-explicit' }, { sql: SQL, backend: fakeBackend({ search }) });
    expect(search.mock.calls[0][1].scope).toContain('workspace:ws-explicit');
    expect(m.activeWorkspaceId).not.toHaveBeenCalled();
  });

  it('degrades when search:semantic throws — still returns mem0 candidates', async () => {
    m.runHybridSearch.mockRejectedValue(new Error('pgvector down'));
    const backend = fakeBackend({ search: vi.fn(async () => [{ id: 'x', text: 'mem x', score: 0.3 }]) });
    const res = await runKnowledgeTier({ query: 'q' }, { sql: SQL, backend });
    expect(res.searched).toEqual(['mem0']); // search:semantic NOT recorded as searched
    expect(res.candidates.map((c) => c.ref)).toEqual(['mem0:x']);
  });

  it('skips mem0 when the backend is unavailable', async () => {
    m.runHybridSearch.mockResolvedValue({ embedderAvailable: true, results: [{ source: 'turns', source_id: '9', excerpt: 't', score: 0.6 }] });
    const search = vi.fn(async () => []);
    const backend = fakeBackend({ available: vi.fn(async () => ({ ok: false })), search });
    const res = await runKnowledgeTier({ query: 'q' }, { sql: SQL, backend });
    expect(res.searched).toEqual(['search:semantic']); // mem0 NOT searched
    expect(search).not.toHaveBeenCalled();
    expect(res.candidates.map((c) => c.ref)).toEqual(['turns:9']);
  });

  it('degrades when backend.search throws — still returns the search candidates', async () => {
    m.runHybridSearch.mockResolvedValue({ embedderAvailable: true, results: [{ source: 'turns', source_id: '9', excerpt: 't', score: 0.6 }] });
    const backend = fakeBackend({
      search: vi.fn(async () => {
        throw new Error('mem0 down');
      }),
    });
    const res = await runKnowledgeTier({ query: 'q' }, { sql: SQL, backend });
    expect(res.candidates.map((c) => c.ref)).toEqual(['turns:9']);
  });
});
