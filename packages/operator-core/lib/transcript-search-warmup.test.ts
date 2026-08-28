/**
 * WI-4734 — boot-time transcript-search pre-warm.
 *
 * The module's contract: warm every leg the interactive search endpoint pays
 * (engine + sources + embedder + PG + roster), fail-soft on EVERY leg (a
 * warmup must never affect boot health), and report which legs completed.
 * Exercised with injected deps — no PG, no embedder model, no network.
 */

import { describe, it, expect, vi } from 'vitest';
import { warmTranscriptSearchPath, type TranscriptSearchWarmupDeps } from './transcript-search-warmup';

function makeDeps(overrides: Partial<TranscriptSearchWarmupDeps> = {}) {
  const runHybridSearch = vi.fn(
    async (_sources: unknown[], _ctx: Record<string, unknown>) => ({ results: [], totalHits: 0 }),
  );
  const buildQueryEmbedder = vi.fn(
    async (_opts?: { acquireBudgetMs?: number }) => async () => [0.1],
  );
  const mergeRosterWithAssignments = vi.fn(
    async (_opts: Record<string, unknown>) => ({ active: [] }),
  );
  const warmCorpusEmbedder = vi.fn(async (_opts?: { acquireBudgetMs?: number }) => true);
  const warmWorkItemQueryEmbedder = vi.fn(async () => true);
  const deps: TranscriptSearchWarmupDeps = {
    loadEngine: async () => ({ runHybridSearch }),
    loadSources: async () => ({
      SEARCH_SOURCES: [{ name: 'session_turn' }, { name: 'escalations' }],
    }),
    loadEmbedder: async () => ({ buildQueryEmbedder }),
    loadWorkspace: async () => ({ activeWorkspaceId: () => 'ws-1' }),
    loadPg: async () => ({ getOrgPg: () => ({ sql: {} }) }),
    loadRoster: async () => ({ mergeRosterWithAssignments }),
    loadCorpusWarmup: async () => ({ warmCorpusEmbedder }),
    loadWorkItemWarmup: async () => ({ warmWorkItemQueryEmbedder }),
    ...overrides,
  };
  return {
    deps,
    runHybridSearch,
    buildQueryEmbedder,
    mergeRosterWithAssignments,
    warmCorpusEmbedder,
    warmWorkItemQueryEmbedder,
  };
}

describe('warmTranscriptSearchPath (WI-4734)', () => {
  it('warms embedder + hybrid search (session_turn only) + roster, and reports both legs', async () => {
    const {
      deps,
      runHybridSearch,
      buildQueryEmbedder,
      mergeRosterWithAssignments,
      warmCorpusEmbedder,
      warmWorkItemQueryEmbedder,
    } = makeDeps();
    const res = await warmTranscriptSearchPath({ log: vi.fn(), deps });

    expect(res.ok).toBe(true);
    expect(res.legs).toEqual({ search: true, roster: true, corpus: true, workItems: true });
    expect(warmCorpusEmbedder).toHaveBeenCalledWith({ acquireBudgetMs: 60_000 });
    expect(warmWorkItemQueryEmbedder).toHaveBeenCalledTimes(1);
    expect(buildQueryEmbedder).toHaveBeenCalledTimes(1);
    // A short acquire budget would abandon the cold warm to the next human
    // query — the exact failure this module exists to prevent.
    expect(buildQueryEmbedder.mock.calls[0][0]).toMatchObject({ acquireBudgetMs: 60_000 });

    expect(runHybridSearch).toHaveBeenCalledTimes(1);
    const [sources, ctx] = runHybridSearch.mock.calls[0]! as [Array<{ name: string }>, Record<string, unknown>];
    expect(sources.map((s) => s.name)).toEqual(['session_turn']); // never the whole registry
    expect(ctx.mode).toBe('hybrid');
    expect(ctx.limit).toBe(1);
    expect(ctx.deferHighlight).toBe(true);

    // Thinking resolution is fully skipped — the warm must not stat every
    // live agent's transcript.
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(1);
    const rosterOpts = mergeRosterWithAssignments.mock.calls[0][0] as {
      workspaceId: null;
      thinkingFor: (e: unknown) => boolean;
    };
    expect(rosterOpts.workspaceId).toBeNull();
    expect(rosterOpts.thinkingFor({})).toBe(false);
  });

  it('one leg failing never blocks the other (search boom → roster still warms, ok stays true)', async () => {
    const { deps, mergeRosterWithAssignments } = makeDeps({
      loadEngine: async () => ({
        runHybridSearch: vi.fn(async () => {
          throw new Error('pg not ready');
        }),
      }),
    });
    const log = vi.fn();
    const res = await warmTranscriptSearchPath({ log, deps });
    expect(res.ok).toBe(true);
    expect(res.legs).toEqual({ search: false, roster: true, corpus: true, workItems: true });
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('search leg failed'));
  });

  it('reports a corpus warmup miss without hiding successful transcript legs', async () => {
    const { deps } = makeDeps({
      loadCorpusWarmup: async () => ({ warmCorpusEmbedder: vi.fn(async () => false) }),
    });
    const log = vi.fn();
    const res = await warmTranscriptSearchPath({ log, deps });

    expect(res.ok).toBe(true);
    expect(res.legs).toEqual({ search: true, roster: true, corpus: false, workItems: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('corpus leg did not become warm'));
  });

  it('a work-item warmup failure is fail-soft and does not hide the other boot legs', async () => {
    const { deps } = makeDeps({
      loadWorkItemWarmup: async () => ({
        warmWorkItemQueryEmbedder: vi.fn(async () => {
          throw new Error('work-item embedder unavailable');
        }),
      }),
    });
    const log = vi.fn();
    const res = await warmTranscriptSearchPath({ log, deps });

    expect(res.ok).toBe(true);
    expect(res.legs).toEqual({ search: true, roster: true, corpus: true, workItems: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('work-item embedder leg failed'));
  });

  it('even a failing import phase resolves (never throws) — a warmup must not affect boot', async () => {
    const { deps } = makeDeps({
      loadPg: async () => {
        throw new Error('db-org unavailable');
      },
    });
    const res = await warmTranscriptSearchPath({ log: vi.fn(), deps });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('db-org unavailable');
  });
});
