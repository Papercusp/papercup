/**
 * canonical-vec-backfill unit tests (EI-10405) — the ORCHESTRATION contract:
 * short-circuit when embedding is off, ask for rows in the ACTIVE mode's vec
 * table, bound the batch, and never let one bad row abort the pass (a failed row
 * keeps its missing vector and is retried on the next tick).
 *
 * The SQL predicate itself (no-vector-yet, entity/archived guards, and the
 * ABSENCE of a source_hive filter — WI-7326) is proven against a REAL Postgres in
 * `canonical-vec-backfill.integration.test.ts` — a fake sql cannot catch a
 * predicate that silently matches nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  backfillCanonicalMemoryVectors,
  type CanonicalMemoryRow,
  type CanonicalVecBackfillDeps,
} from './canonical-vec-backfill';

const ACTIVE = { mode: 'local' as const, profileId: 'local-bge-small-en-v1.5@v1' as const, schema: 'harness_shared', table: 'memory_vec_local' };

const rows = (...ids: string[]): CanonicalMemoryRow[] =>
  ids.map((id) => ({ id, data: `text for ${id}` }));

/** Deps with everything stubbed — no PG, no embedder. */
const deps = (over: Partial<CanonicalVecBackfillDeps> = {}): CanonicalVecBackfillDeps => ({
  sql: {} as never,
  resolveVecTable: async () => ACTIVE,
  selectRows: async () => rows('a', 'b'),
  embed: async () => true,
  // Healthy-idle by default. Stubbed rather than left to the real probe because
  // `sql` here is `{}` — an unstubbed probe would throw into the non-fatal catch
  // and silently yield `zeroYield: undefined`, i.e. the tests would pass while
  // exercising the error path instead of the one they name.
  probeZeroYield: async () => ({ vectorSpaceEmpty: false, canonicalHasRows: true }),
  ...over,
});

/** The resolved-target fields every non-skipped pass now reports (EI-19409840792445272). */
const TARGET = { mode: ACTIVE.mode, table: ACTIVE.table };

describe('backfillCanonicalMemoryVectors', () => {
  it('embeds every row missing a vector', async () => {
    const embed = vi.fn(async () => true);
    const r = await backfillCanonicalMemoryVectors(deps({ embed }));
    expect(r).toEqual({ scanned: 2, embedded: 2, failed: 0, ...TARGET });
    expect(embed).toHaveBeenCalledTimes(2);
    // The row's canonical TEXT is what gets embedded, keyed by its id.
    expect(embed).toHaveBeenCalledWith('a', 'text for a');
  });

  it('short-circuits when embedding is disabled — no query, no embed', async () => {
    const selectRows = vi.fn(async () => rows('a'));
    const embed = vi.fn(async () => true);
    const r = await backfillCanonicalMemoryVectors(
      deps({ resolveVecTable: async () => null, selectRows, embed }),
    );
    // `skipped` distinguishes "embedding is off" from an honest empty sweep.
    expect(r).toEqual({ scanned: 0, embedded: 0, failed: 0, skipped: 'embedder-disabled' });
    expect(selectRows).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('asks for rows in the ACTIVE mode vec table, bounded by the batch limit', async () => {
    const selectRows = vi.fn(async () => []);
    await backfillCanonicalMemoryVectors(
      deps({
        resolveVecTable: async () => ({ mode: 'harrier', profileId: 'harrier-oss-v1-0.6b-1024@v1', schema: 'hs', table: 'memory_vec_harrier' }),
        selectRows,
        limit: 7,
      }),
    );
    expect(selectRows).toHaveBeenCalledWith({}, 'hs', 'memory_vec_harrier', 7);
  });

  it('an empty sweep is not a skip', async () => {
    const r = await backfillCanonicalMemoryVectors(deps({ selectRows: async () => [] }));
    expect(r).toEqual({
      scanned: 0,
      embedded: 0,
      failed: 0,
      ...TARGET,
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    });
  });

  // EI-19409840792445272: {scanned:0,embedded:0,failed:0} is returned BOTH when
  // there is genuinely nothing to do and when the predicate matches nothing while
  // recall reads an empty space. The second is a total outage. The counts cannot
  // tell them apart, so the probe must — otherwise the caller has nothing to log.
  it('reports the zero-yield probe so an idle sweep is distinguishable from a dead one', async () => {
    const r = await backfillCanonicalMemoryVectors(
      deps({
        selectRows: async () => [],
        probeZeroYield: async () => ({ vectorSpaceEmpty: true, canonicalHasRows: true }),
      }),
    );
    expect(r.zeroYield).toEqual({ vectorSpaceEmpty: true, canonicalHasRows: true });
  });

  it('only probes on the ZERO-YIELD path — a productive pass pays nothing', async () => {
    const probeZeroYield = vi.fn(async () => ({ vectorSpaceEmpty: false, canonicalHasRows: true }));
    await backfillCanonicalMemoryVectors(deps({ probeZeroYield }));
    expect(probeZeroYield).not.toHaveBeenCalled();
  });

  // The probe is a diagnostic. A diagnostic that can fail the thing it observes is
  // worse than no diagnostic: a healthy sweep must stay healthy when it throws.
  it('a throwing probe never fails the sweep', async () => {
    const r = await backfillCanonicalMemoryVectors(
      deps({
        selectRows: async () => [],
        probeZeroYield: async () => {
          throw new Error('pg down');
        },
      }),
    );
    expect(r).toEqual({ scanned: 0, embedded: 0, failed: 0, ...TARGET });
  });

  // The whole misdiagnosis this item came from was "which table is this sweep even
  // maintaining?" being unanswerable from outside. It must always be reported.
  it('always names the resolved mode + table', async () => {
    const r = await backfillCanonicalMemoryVectors(
      deps({
        resolveVecTable: async () => ({ mode: 'harrier', profileId: 'harrier-oss-v1-0.6b-1024@v1', schema: 'hs', table: 'memory_vec_harrier' }),
      }),
    );
    expect(r.mode).toBe('harrier');
    expect(r.table).toBe('memory_vec_harrier');
  });

  it('counts a failed embed and still processes the remaining rows (retried next tick)', async () => {
    const embed = vi.fn(async (id: string) => id !== 'b');
    const r = await backfillCanonicalMemoryVectors(
      deps({ selectRows: async () => rows('a', 'b', 'c'), embed }),
    );
    expect(r).toEqual({ scanned: 3, embedded: 2, failed: 1, ...TARGET });
    expect(embed).toHaveBeenCalledTimes(3);
  });

  it('a THROWING embed never aborts the pass (the seam is injectable; the sweep is non-fatal)', async () => {
    const embed = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('sidecar down');
      return true;
    });
    const r = await backfillCanonicalMemoryVectors(
      deps({ selectRows: async () => rows('a', 'b'), embed }),
    );
    expect(r).toEqual({ scanned: 2, embedded: 1, failed: 1, ...TARGET });
    expect(embed).toHaveBeenCalledTimes(2); // 'b' still got its vector
  });
});
