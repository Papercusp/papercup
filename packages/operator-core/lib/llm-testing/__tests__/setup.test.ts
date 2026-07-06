/**
 * applyScenarioSetup — the operator's `RunnerDeps.applySetup` seam
 * (memory-backend-benchmark-2026-06-05 P-009).
 *
 * Uses an in-memory fake MemoryBackend (injected via the backendOverride
 * test seam) — no PG, no embedder. Verifies:
 *   - seeds write VERBATIM with llm_testing metadata + the run id,
 *   - scope defaults to the harness pool and respects per-entry scope,
 *   - the returned cleanup forgets every seeded id,
 *   - empty-result seeding throws (a gotcha that never landed would
 *     silently measure nothing),
 *   - partial-seeding failures roll back what already landed,
 *   - an unavailable backend throws instead of seeding nothing.
 */

import { describe, expect, it } from 'vitest';

import type { MemoryBackend, MemoryEntry, RememberOptions } from '../../memory/backend';
import { applyScenarioSetup, defaultSeedScope } from '../setup';

interface FakeState {
  entries: Map<string, { text: string; opts: RememberOptions }>;
  forgets: string[];
  remembers: Array<{ text: string; opts: RememberOptions }>;
  searches: Array<{ query: string; scope: string | readonly string[]; limit?: number }>;
}

function makeFakeBackend(
  over: Partial<MemoryBackend> = {},
): { backend: MemoryBackend; state: FakeState } {
  const state: FakeState = { entries: new Map(), forgets: [], remembers: [], searches: [] };
  let nextId = 1;
  const backend: MemoryBackend = {
    name: 'fake',
    available: async () => ({ ok: true }),
    remember: async (text, opts) => {
      state.remembers.push({ text, opts });
      const id = `m-${nextId++}`;
      state.entries.set(id, { text, opts });
      return { ids: [id], storedEvents: 1 };
    },
    search: async (query, opts) => {
      state.searches.push({ query, scope: opts.scope, limit: opts.limit });
      const hits = [...state.entries.entries()]
        .map(([id, entry]) => ({ id, text: entry.text, scope: entry.opts.scope, kind: entry.opts.kind, metadata: entry.opts.metadata }))
        .filter((entry) => entry.scope === opts.scope || (Array.isArray(opts.scope) && opts.scope.includes(entry.scope)))
        .filter((entry) => entry.text === query);
      return hits as MemoryEntry[];
    },
    list: async () => [],
    get: async () => null as MemoryEntry | null,
    forget: async (id) => {
      state.forgets.push(id);
      state.entries.delete(id);
    },
    update: async () => {},
    ...over,
  };
  return { backend, state };
}

describe('applyScenarioSetup', () => {
  it('seeds verbatim with llm_testing metadata and run id, then cleanup forgets all', async () => {
    const { backend, state } = makeFakeBackend();
    const cleanup = await applyScenarioSetup(
      {
        mem0: [
          { kind: 'project', body: 'fact one' },
          { kind: 'feedback', body: 'fact two', scope: 'harness:sheets' },
        ],
      },
      { runId: 'run-1' },
      backend,
    );

    expect(state.remembers).toHaveLength(2);
    expect(state.searches).toEqual([
      { query: 'fact one', scope: defaultSeedScope(), limit: 5 },
      { query: 'fact two', scope: 'harness:sheets', limit: 5 },
    ]);
    for (const r of state.remembers) {
      expect(r.opts.verbatim).toBe(true);
      expect(r.opts.metadata).toMatchObject({ llm_testing: true, run_id: 'run-1' });
    }
    expect(state.remembers[0].opts.scope).toBe(defaultSeedScope());
    expect(state.remembers[0].opts.kind).toBe('project');
    expect(state.remembers[1].opts.scope).toBe('harness:sheets');

    expect(typeof cleanup).toBe('function');
    await cleanup!();
    expect(state.forgets.sort()).toEqual(['m-1', 'm-2']);
    expect(state.entries.size).toBe(0);
  });

  it('returns void when there is nothing to seed', async () => {
    const { backend, state } = makeFakeBackend();
    const cleanup = await applyScenarioSetup({}, { runId: 'r' }, backend);
    expect(cleanup).toBeUndefined();
    expect(state.remembers).toHaveLength(0);
  });

  it('throws when a seed stores nothing', async () => {
    const { backend } = makeFakeBackend({
      remember: async () => ({ ids: [], storedEvents: 0 }),
    });
    await expect(
      applyScenarioSetup({ mem0: [{ kind: 'project', body: 'ghost' }] }, { runId: 'r' }, backend),
    ).rejects.toThrow(/stored NOTHING/);
  });

  it('rolls back already-seeded entries when a later seed fails', async () => {
    const { backend, state } = makeFakeBackend();
    const realRemember = backend.remember.bind(backend);
    let call = 0;
    backend.remember = async (text, opts) => {
      call++;
      if (call === 2) throw new Error('embedder down');
      return realRemember(text, opts);
    };
    await expect(
      applyScenarioSetup(
        { mem0: [{ kind: 'project', body: 'a' }, { kind: 'project', body: 'b' }] },
        { runId: 'r' },
        backend,
      ),
    ).rejects.toThrow('embedder down');
    // The first seed landed (m-1) and must have been rolled back.
    expect(state.forgets).toEqual(['m-1']);
    expect(state.entries.size).toBe(0);
  });

  it('throws when the backend is unavailable', async () => {
    const { backend } = makeFakeBackend({
      available: async () => ({ ok: false, reason: 'pg_down' }),
    });
    await expect(
      applyScenarioSetup({ mem0: [{ kind: 'project', body: 'x' }] }, { runId: 'r' }, backend),
    ).rejects.toThrow(/unavailable \(pg_down\)/);
  });

  it('throws when a freshly written seed is not immediately recallable', async () => {
    const { backend } = makeFakeBackend({
      search: async () => [],
    });
    await expect(
      applyScenarioSetup({ mem0: [{ kind: 'project', body: 'ghost' }] }, { runId: 'r' }, backend),
    ).rejects.toThrow(/not immediately recallable after write/);
  });
});
