/**
 * federated-vec-backfill unit tests (EI-10405) — the ORCHESTRATION contract:
 * short-circuit when embedding is off, ask for rows in the ACTIVE mode's vec
 * table, bound the batch, and never let one bad row abort the pass (a failed row
 * keeps its missing vector and is retried on the next tick).
 *
 * The SQL predicate itself (federated-only, no-vector-yet, entity/archived
 * guards) is proven against a REAL Postgres in
 * `federated-vec-backfill.integration.test.ts` — a fake sql cannot catch a
 * predicate that silently matches nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  backfillFederatedMemoryVectors,
  type FederatedMemoryRow,
  type FederatedVecBackfillDeps,
} from './federated-vec-backfill';

const ACTIVE = { mode: 'local' as const, schema: 'harness_shared', table: 'memory_vec_local' };

const rows = (...ids: string[]): FederatedMemoryRow[] =>
  ids.map((id) => ({ id, data: `text for ${id}` }));

/** Deps with everything stubbed — no PG, no embedder. */
const deps = (over: Partial<FederatedVecBackfillDeps> = {}): FederatedVecBackfillDeps => ({
  sql: {} as never,
  resolveVecTable: async () => ACTIVE,
  selectRows: async () => rows('a', 'b'),
  embed: async () => true,
  ...over,
});

describe('backfillFederatedMemoryVectors', () => {
  it('embeds every federated row missing a vector', async () => {
    const embed = vi.fn(async () => true);
    const r = await backfillFederatedMemoryVectors(deps({ embed }));
    expect(r).toEqual({ scanned: 2, embedded: 2, failed: 0 });
    expect(embed).toHaveBeenCalledTimes(2);
    // The row's canonical TEXT is what gets embedded, keyed by its id.
    expect(embed).toHaveBeenCalledWith('a', 'text for a');
  });

  it('short-circuits when embedding is disabled — no query, no embed', async () => {
    const selectRows = vi.fn(async () => rows('a'));
    const embed = vi.fn(async () => true);
    const r = await backfillFederatedMemoryVectors(
      deps({ resolveVecTable: async () => null, selectRows, embed }),
    );
    // `skipped` distinguishes "embedding is off" from an honest empty sweep.
    expect(r).toEqual({ scanned: 0, embedded: 0, failed: 0, skipped: 'embedder-disabled' });
    expect(selectRows).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('asks for rows in the ACTIVE mode vec table, bounded by the batch limit', async () => {
    const selectRows = vi.fn(async () => []);
    await backfillFederatedMemoryVectors(
      deps({
        resolveVecTable: async () => ({ mode: 'harrier', schema: 'hs', table: 'memory_vec_harrier' }),
        selectRows,
        limit: 7,
      }),
    );
    expect(selectRows).toHaveBeenCalledWith({}, 'hs', 'memory_vec_harrier', 7);
  });

  it('an empty sweep is not a skip', async () => {
    const r = await backfillFederatedMemoryVectors(deps({ selectRows: async () => [] }));
    expect(r).toEqual({ scanned: 0, embedded: 0, failed: 0 });
  });

  it('counts a failed embed and still processes the remaining rows (retried next tick)', async () => {
    const embed = vi.fn(async (id: string) => id !== 'b');
    const r = await backfillFederatedMemoryVectors(
      deps({ selectRows: async () => rows('a', 'b', 'c'), embed }),
    );
    expect(r).toEqual({ scanned: 3, embedded: 2, failed: 1 });
    expect(embed).toHaveBeenCalledTimes(3);
  });

  it('a THROWING embed never aborts the pass (the seam is injectable; the sweep is non-fatal)', async () => {
    const embed = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('sidecar down');
      return true;
    });
    const r = await backfillFederatedMemoryVectors(
      deps({ selectRows: async () => rows('a', 'b'), embed }),
    );
    expect(r).toEqual({ scanned: 2, embedded: 1, failed: 1 });
    expect(embed).toHaveBeenCalledTimes(2); // 'b' still got its vector
  });
});
