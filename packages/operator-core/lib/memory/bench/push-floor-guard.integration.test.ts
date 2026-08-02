/**
 * push-floor-guard.integration.test.ts — THE P-002 RECURRENCE GUARD, live
 * (context-injection-audit-2026-07-28 P-002).
 *
 * "The test whose absence let a 0.45 floor run at 0.03 for months." It replays
 * the frozen hard-negative class — 30 deliberately off-topic queries, all
 * `expected: []` — through the REAL push admission contract against the REAL
 * corpus (corpus.v1 = the owner's own memory, 114 entries) in an isolated PG
 * schema, and asserts:
 *
 *   (a) an off-topic query admits ZERO entries, and
 *   (b) no admitted entry's COSINE score is below the configured cosine floor.
 *
 * WHY THIS IS AN INTEGRATION TEST AND NOT A FIXTURE TEST: D-041's method rule
 * binds — a RELEVANCE claim must be verified against the REAL corpus; fixtures
 * are admissible for transport, budget, dedup and throttle only. A hand-built
 * corpus would let the author choose how far the hard-negatives sit from the
 * hits, which is precisely the quantity under test. The violation LOGIC is
 * unit-tested separately in `push-floor-guard.test.ts`.
 *
 * WHAT IT COSTS: embeddings only — 114 corpus seeds + ~150 gold queries + one
 * unfloored cosine probe per query that admitted anything. No LLM, no writes to
 * the live store (`bench_memory_<pid>`, dropped in teardown).
 *
 * ⚠ ORDERING IS LOAD-BEARING: the positive control is asserted BEFORE the floor
 * verdict. An empty/failed corpus satisfies (a) perfectly while measuring
 * nothing (EI-10793 recorded three such all-zero runs as legitimate), so a zero
 * on an off-topic query is only attributable to the floor once the same path is
 * shown retrieving real hits over the same corpus in the same run.
 *
 * ⚠ Assertion (b) is NOT `entry.score >= 0.45`. The returned score is RRF
 * (~0.016 max/leg); the floor is cosine. See `push-floor-guard.ts` §TRAP 1 —
 * that conflation is D-001's retracted headline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HybridBackend,
  LexicalLegBackend,
  Mem0Backend,
  disposeMemoryClient,
  type MemoryBackend,
} from '@papercusp/memory';
import { seedCorpus } from '@papercusp/memory/bench';
import type { Client } from 'pg';

import { INJECTION_TOTAL_LIMIT, pushSearchFloors } from '../injection';
import { benchPgClient, dropBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench-host';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import { assertCorpusSeeded } from './precision-monitor';
import { BENCH_SCOPE } from './run-bench';
import {
  positiveControlFailure,
  probePushFloor,
  summarizeProbe,
  type FloorProbeQuery,
  type PushFloorProbeResult,
} from './push-floor-guard';

/** Seeding 114 entries + ~150 queries through a real embedder is not fast. */
const SETUP_TIMEOUT_MS = 600_000;

describe('P-002 — the push path admits nothing off-topic and nothing below the floor', () => {
  let pg: Client;
  let cosineLeg: Mem0Backend;
  let backend: MemoryBackend;
  let result: PushFloorProbeResult;
  let setupError: Error | null = null;

  beforeAll(async () => {
    try {
      // Mirrors makeBackendCtx('hybrid-pg') — the PRODUCTION wiring: both legs
      // over one bench PG schema, the lexical leg a projection of the same
      // canonical store. Built inline rather than via makeBackendCtx because the
      // guard needs a handle on the COSINE LEG ITSELF for the (b) ground truth,
      // and the ctx exposes only the fused backend.
      setupBenchMemoryHost();
      pg = await benchPgClient();
      await ensureBenchSchema(pg);
      cosineLeg = new Mem0Backend();
      backend = new HybridBackend(new LexicalLegBackend(cosineLeg), cosineLeg, { name: 'hybrid-pg' });

      const corpus = loadCorpusFixture('v1');
      const manifest = await seedCorpus(backend, corpus, {
        scope: BENCH_SCOPE,
        verbatim: true,
        concurrency: 8,
      });
      // A partial seed silently changes the corpus this guard reports on, and an
      // under-seeded corpus makes (a) pass for infrastructure reasons. Throw.
      assertCorpusSeeded(manifest, corpus.length);

      const gold = loadGoldSetFixture('v1');
      const queries: FloorProbeQuery[] = gold.queries.map((q) => ({
        id: q.id,
        query: q.query,
        className: q.class,
        // The hard-negative class IS the off-topic stimulus, already frozen with
        // `expected: []` — no hand-authored off-topic query is needed or wanted.
        expectEmpty: q.class === 'hard-negative',
      }));

      result = await probePushFloor({
        backend,
        cosineLeg,
        scope: BENCH_SCOPE,
        queries,
        // The LIVE contract, from the same constructor buildBlockInner calls.
        floors: pushSearchFloors(),
        limit: INJECTION_TOTAL_LIMIT,
        // Deeper than the corpus, so "absent from the cosine result" means the
        // cosine leg genuinely did not return it — not that the probe truncated.
        cosineProbeLimit: Math.max(200, corpus.length * 2),
        corpusSeeded: Object.keys(manifest.ids).length,
      });
      // eslint-disable-next-line no-console -- the measurement is the artifact
      console.log(`[P-002] ${summarizeProbe(result)}`);
    } catch (e) {
      setupError = e instanceof Error ? e : new Error(String(e));
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await disposeMemoryClient().catch(() => {});
    if (pg) {
      await dropBenchSchema(pg).catch(() => {});
      await pg.end().catch(() => {});
    }
  });

  /**
   * A setup failure must FAIL, never skip. A guard that silently no-ops when the
   * embedder is cold or PG is unreachable is indistinguishable from a guard that
   * passes, which is how the floor ran unmeasured for months in the first place.
   */
  it('the instrument built and ran', () => {
    expect(setupError, setupError?.message).toBeNull();
    expect(result).toBeDefined();
  });

  it('POSITIVE CONTROL — the push path retrieves over this corpus (read before the verdict)', () => {
    expect(positiveControlFailure(result)).toBeNull();
  });

  it('the floors under test are the LIVE production values', () => {
    // Pins what the run actually measured, so a green result can never be
    // mistaken for a green result at a DIFFERENT (e.g. env-disabled) floor.
    expect(result.floors.minScore).toBeGreaterThan(0);
    expect(result.floors.minLexScore).toBeGreaterThan(0);
    expect(result.floors).toEqual(pushSearchFloors());
  });

  it('(a) every off-topic query admits ZERO entries', () => {
    const admitting = result.offTopic.filter((o) => o.admitted > 0);
    const detail = admitting
      .slice(0, 5)
      .map((o) => `  ${o.queryId} "${o.query}" → ${o.admitted}: ${o.entries.map((e) => e.text.slice(0, 60)).join(' | ')}`)
      .join('\n');
    expect(
      admitting.length,
      `${admitting.length}/${result.offTopic.length} off-topic queries admitted entries:\n${detail}`,
    ).toBe(0);
  });

  it('(b) no admitted entry scores below the configured cosine floor', () => {
    const detail = result.violations
      .slice(0, 10)
      .map((v) => `  ${v.queryId} ${v.entryId} ${v.kind} cos=${v.cosineScore ?? 'none'} < ${v.floor}: ${v.text}`)
      .join('\n');
    expect(result.violations.length, `${result.violations.length} floor violations:\n${detail}`).toBe(0);
  });
});
