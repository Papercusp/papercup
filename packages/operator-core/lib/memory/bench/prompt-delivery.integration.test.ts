/**
 * P-006 delivery measurement: frozen real memory corpus -> real embedding/PG
 * hybrid search -> production renderer -> the unchanged two-second cache wait.
 * All memory, hygiene and telemetry SQL goes to a migrated throwaway org DB.
 * The independent prose-corpus leg is disabled explicitly; this measures the
 * memory leg, not the combined prose+memory service or a deployed runtime.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCache } from '@papercusp/cache';
import {
  configureMemory,
  memoryHost,
  disposeMemoryClient,
  getResolvedProfile,
  HybridBackend,
  LexicalLegBackend,
  Mem0Backend,
  type ExtractionLlm,
  type MemoryBackend,
  type SearchLegStats,
} from '@papercusp/memory';
import { seedCorpus, type GoldQuery, type SeedManifest } from '@papercusp/memory/bench';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { setupBenchMemoryHost } from './bench-host';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import { assertCorpusSeeded } from './precision-monitor';
import { buildMemoryContextBlock, pushSearchFloors } from '../injection';
import { getMemoryBlockBoundedResult, MEMORY_BLOCK_COLD_DEADLINE_MS } from '../injection-block-cache';

let db: OrgTestDb;
let backend: MemoryBackend;
const writes = new Set<Promise<unknown>>();
let recallStatsCalls = 0;
let measuredCalls = 0;
let blockBuilds = 0;
const recallStatsCallsByQuery = new Map<string, number>();
const verbatimOnlyExtractionLlm: ExtractionLlm = {
  async generateResponse() {
    throw new Error('P-006 verbatim seed unexpectedly invoked fact extraction');
  },
  async generateChat() {
    throw new Error('P-006 verbatim seed unexpectedly invoked extraction chat');
  },
};

// Fail closed before setup; never fall back to the live org's hygiene tables.
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    if (!db) throw new Error('delivery benchmark database is not ready');
    return { sql: db.adminSql };
  },
}));
vi.mock('../backend', () => ({ getMemoryBackend: () => backend }));
vi.mock('../corpus-recall-io', () => ({
  recallCorpusContext: async () => ({
    block: null,
    lines: [],
    dropped: [],
    embedderAvailable: true,
    candidateCount: 0,
    outcome: 'disabled',
  }),
}));
vi.mock('../../session-brief', () => ({ getSessionBriefAmbientExcludedRefs: async () => new Set() }));
// Advisory feature policy is pinned for this profile; retrieval floors, ranking,
// feedback, dedup and rendering remain the actual production implementations.
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));
vi.mock('../recall-stats', async (original) => {
  const actual = await original<typeof import('../recall-stats')>();
  return {
    ...actual,
    recordRecallStats: (...args: Parameters<typeof actual.recordRecallStats>) => {
      recallStatsCalls += 1;
      const row = context.getStore();
      if (row) {
        row.telemetryCalls += 1;
        recallStatsCallsByQuery.set(row.queryId, (recallStatsCallsByQuery.get(row.queryId) ?? 0) + 1);
      }
      if (process.env.PAPERCUSP_P006_RECALL_STATS === 'off') return Promise.resolve();
      const p = actual.recordRecallStats(...args);
      writes.add(p);
      void p.finally(() => writes.delete(p));
      return p;
    },
  };
});

interface Reading {
  queryId: string;
  phase: string;
  telemetryCalls: number;
  className: string;
  expected: string[];
  status: string;
  callerMs: number;
  buildMs: number;
  availableMs: number;
  searchMs: number;
  embedMs: number;
  embedCalls: number;
  retrieved: string[];
  delivered: string[];
  relevantDelivered: string[];
  legs?: SearchLegStats;
  error?: string;
}
const context = new AsyncLocalStorage<Reading>();
const attempts: Reading[] = [];
const profiles: Array<{ name: string; concurrency: number; rows: Reading[] }> = [];
let manifest: SeedManifest;
let setupError: unknown;
let sequence = 0;
const workspaceId = 'memory-delivery-benchmark';
const scope = 'harness:delivery-corpus';
const repoRoot = new URL('../../../../../', import.meta.url);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
};

function summarize(rows: Reading[]) {
  // Eligibility is fixed BEFORE retrieval from the gold set. A failed or empty
  // retrieval cannot silently shrink the denominator and improve coverage.
  const eligible = rows.filter((r) => r.expected.length > 0);
  const timely = (r: Reading) => r.status === 'ready' && r.callerMs <= MEMORY_BLOCK_COLD_DEADLINE_MS;
  const useful = eligible.filter((r) => timely(r) && r.relevantDelivered.length > 0);
  return {
    calls: rows.length,
    eligible: eligible.length,
    usefulWithinDeadline: useful.length,
    usefulRate: useful.length / eligible.length,
    anyContextWithinDeadline: eligible.filter((r) => timely(r) && r.delivered.length > 0).length,
    deadlines: rows.filter((r) => r.status === 'deadline').length,
    errors: rows.filter((r) => r.error || r.status === 'error').length,
    empty: rows.filter((r) => r.delivered.length === 0).length,
    p50CallerMs: quantile(
      rows.map((r) => r.callerMs),
      0.5,
    ),
    p95CallerMs: quantile(
      rows.map((r) => r.callerMs),
      0.95,
    ),
    p95BuildMs: quantile(
      rows.map((r) => r.buildMs),
      0.95,
    ),
    p95SearchMs: quantile(
      rows.map((r) => r.searchMs),
      0.95,
    ),
    p95EmbedMs: quantile(
      rows.map((r) => r.embedMs),
      0.95,
    ),
    p95PostSearchMs: quantile(
      rows.map((r) => Math.max(0, r.buildMs - r.availableMs - r.searchMs)),
      0.95,
    ),
    embedCalls: rows.reduce((sum, r) => sum + r.embedCalls, 0),
  };
}

async function measure(query: GoldQuery, phase: string): Promise<Reading> {
  measuredCalls += 1;
  const row: Reading = {
    queryId: query.id,
    phase,
    telemetryCalls: 0,
    className: query.class,
    expected: query.expected,
    status: 'unmeasured',
    callerMs: 0,
    buildMs: 0,
    availableMs: 0,
    searchMs: 0,
    embedMs: 0,
    embedCalls: 0,
    retrieved: [],
    delivered: [],
    relevantDelivered: [],
  };
  return context.run(row, async () => {
    const id = `delivery-${process.pid}-${++sequence}`;
    let build: Promise<string | null> | undefined;
    const started = performance.now();
    const result = await getMemoryBlockBoundedResult(
      workspaceId,
      id,
      () => {
        blockBuilds += 1;
        const buildStarted = performance.now();
        build = buildMemoryContextBlock({
          workspaceId,
          harnessSlugs: ['delivery-corpus'],
          potSlugs: [],
          queryContext: query.query,
          // Independent eligible turns, not repeatedly deduped turns of one session.
          session: { sessionId: id, epoch: 0, port: 'turn-start' },
        }).finally(() => {
          row.buildMs = performance.now() - buildStarted;
        });
        return build;
      },
      { cache: createCache() },
    );
    row.callerMs = performance.now() - started;
    row.status = result.status;
    const ids = new Set(Array.from((result.block ?? '').matchAll(/\(id=([^\s)]+)\)/g), (m) => m[1]));
    row.delivered = Object.entries(manifest.ids)
      .filter(([, memoryIds]) => memoryIds.some((memoryId) => ids.has(memoryId)))
      .map(([key]) => key);
    row.relevantDelivered = row.delivered.filter((key) => query.expected.includes(key));
    // Preserve the caller outcome BEFORE joining late work. Joining drains the
    // current bounded burst and makes teardown unable to erase its evidence.
    await build?.catch((error) => {
      row.error = inspect(error);
    });
    attempts.push(row);
    return row;
  });
}

describe('P-006 frozen real-corpus prompt delivery', () => {
  beforeAll(async () => {
    try {
      console.log('[P-006 setup] creating isolated org database');
      db = await createOrgTestDb();
      console.log('[P-006 setup] isolated org database ready');
      setupBenchMemoryHost('harness_shared');
      const base = memoryHost();
      configureMemory({
        ...base,
        getAdminUrl: () => db.adminDsn,
        // Client construction requires an extraction provider even though this
        // benchmark seeds exclusively through infer:false. Keep the fixture
        // credential-independent and fail loudly if that invariant regresses.
        getExtractionLlm: async () => verbatimOnlyExtractionLlm,
        resolveEmbedder: async () => {
          const resolved = await base.resolveEmbedder();
          if (resolved.mode === 'disabled') return resolved;
          return {
            ...resolved,
            embed: async (text, signal) => {
              const row = context.getStore();
              const start = performance.now();
              if (row) row.embedCalls += 1;
              try {
                return await resolved.embed(text, signal);
              } finally {
                if (row) row.embedMs += performance.now() - start;
              }
            },
          };
        },
      });
      const cosine = new Mem0Backend();
      const real = new HybridBackend(new LexicalLegBackend(cosine), cosine, { name: 'hybrid-pg' });
      backend = new Proxy(real, {
        get(target, key) {
          if (key === 'available')
            return async () => {
              const row = context.getStore();
              const start = performance.now();
              try {
                return await target.available();
              } finally {
                if (row) row.availableMs += performance.now() - start;
              }
            };
          if (key === 'search')
            return async (...[query, opts]: Parameters<MemoryBackend['search']>) => {
              const row = context.getStore();
              const start = performance.now();
              try {
                const entries = await target.search(query, {
                  ...opts,
                  onLegStats: (legs) => {
                    if (row) row.legs = legs;
                    opts.onLegStats?.(legs);
                  },
                });
                if (row) row.retrieved = entries.map((entry) => String(entry.metadata?.corpus_key ?? entry.id));
                return entries;
              } catch (error) {
                if (row) row.error = String(error);
                throw error;
              } finally {
                if (row) row.searchMs += performance.now() - start;
              }
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const corpus = loadCorpusFixture();
      console.log('[P-006 setup] seeding frozen corpus');
      const seedStarted = performance.now();
      manifest = await seedCorpus(backend, corpus, {
        scope,
        verbatim: true,
        concurrency: 8,
        maxAttempts: 3,
        retryDelayMs: 1_000,
        onProgress: (done, total) => {
          if (done === total || done % 10 === 0)
            console.log(
              '[P-006 seed-progress]',
              JSON.stringify({ done, total, elapsedMs: Math.round(performance.now() - seedStarted) }),
            );
        },
      });
      assertCorpusSeeded(manifest, corpus.length);
      console.log(
        '[P-006 setup] frozen corpus seeded',
        JSON.stringify({ elapsedMs: Math.round(performance.now() - seedStarted) }),
      );
      const queries = loadGoldSetFixture().queries;
      const sourcePaths = [
        'packages/operator-core/lib/memory/injection.ts',
        'packages/operator-core/lib/memory/injection-block-cache.ts',
        'packages/operator-core/lib/memory/recall-stats.ts',
        'libs/generic/memory/src/mem0-backend.ts',
        'libs/generic/memory/src/mem0-client.ts',
        'libs/generic/memory/src/hybrid-backend.ts',
        'packages/operator-core/lib/memory/bench/prompt-delivery.integration.test.ts',
      ];
      console.log(
        '[P-006 profile]',
        JSON.stringify({
          host: hostname(),
          node: process.version,
          corpusHash: hash(JSON.stringify(corpus)),
          requestsHash: hash(JSON.stringify(queries)),
          corpusSize: corpus.length,
          queries: queries.length,
          sourceHashes: Object.fromEntries(
            sourcePaths.map((path) => [path, hash(readFileSync(fileURLToPath(new URL(path, repoRoot)), 'utf8'))]),
          ),
          embedder: getResolvedProfile(),
          floors: pushSearchFloors(),
          deadlineMs: MEMORY_BLOCK_COLD_DEADLINE_MS,
          recallStats: process.env.PAPERCUSP_P006_RECALL_STATS === 'off' ? 'off' : 'on',
          isolation: 'throwaway org DB including hygiene; prose disabled; advisory flags false',
          cache: 'cold rendered-block cache per turn; cold client before each profile; warm query immediately primed',
        }),
      );
      for (const [name, concurrency, warm] of [
        ['normal-cold', 1, false],
        ['normal-warm', 1, true],
        ['burst-cold', 8, false],
      ] as const) {
        await disposeMemoryClient();
        const rows: Reading[] = new Array(queries.length);
        let cursor = 0;
        await Promise.all(
          Array.from({ length: concurrency }, async () => {
            while (cursor < queries.length) {
              const index = cursor++;
              if (warm) await measure(queries[index], `${name}-prime`);
              rows[index] = await measure(queries[index], name);
            }
          }),
        );
        profiles.push({ name, concurrency, rows });
        // Keep aggregate evidence readable through the router's stdout/stderr
        // merge. Printing every hit of 150 rows made a single JSON line larger
        // than a pipe write, letting stderr split it before it could be parsed.
        const misses = rows.filter((row) => row.expected.length > 0 && (
          row.status !== 'ready' || row.callerMs > MEMORY_BLOCK_COLD_DEADLINE_MS || row.relevantDelivered.length === 0
        ));
        console.log('[P-006 result]', JSON.stringify({ name, concurrency, ...summarize(rows), misses }));
      }
      // The warm profile intentionally primes each query once, so the three
      // measured profiles issue four recalls per gold query. Wait until every
      // fire-and-forget call has reached the mocked writer, then drain the
      // writer promises and prove serialization preserved one durable row per
      // recall. A latency-only pass could otherwise hide a queue that merely
      // shed telemetry to get out of the retrieval path.
      const expectedRecallStatsCalls = queries.length * 4;
      await vi.waitFor(() => expect(blockBuilds).toBe(measuredCalls), { timeout: 5_000 });
      // A completed block means its `finally` scheduled telemetry; it does not
      // mean the fire-and-forget async continuation has crossed the dynamic
      // import/corpus join and invoked the writer yet. Join that scheduling
      // boundary explicitly before snapshotting `writes`, otherwise a fast
      // profile can misclassify pending rows as dropped rows.
      let missingTelemetry: Array<{ queryId: string; calls: number }> = [];
      try {
        await vi.waitFor(() => expect(recallStatsCalls).toBe(expectedRecallStatsCalls), { timeout: 5_000 });
      } finally {
        // The diagnostic must survive the failing assertion it explains,
        // including warm-prime failures that are not measured profile rows.
        missingTelemetry = queries
          .map((query) => ({ queryId: query.id, calls: recallStatsCallsByQuery.get(query.id) ?? 0 }))
          .filter((entry) => entry.calls !== 4);
        console.log(
          '[P-006 telemetry-scheduling]',
          JSON.stringify({ measuredCalls, blockBuilds, recallStatsCalls, expectedRecallStatsCalls, missingTelemetry,
            missingAttempts: attempts.filter((row) => row.telemetryCalls !== 1) }),
        );
      }
      expect(
        recallStatsCalls,
        JSON.stringify({ measuredCalls, blockBuilds, recallStatsCalls, expectedRecallStatsCalls, missingTelemetry }),
      ).toBe(expectedRecallStatsCalls);
      await Promise.allSettled([...writes]);
      const countRows = await db.adminSql`
        SELECT count(*)::int AS recall_count
        FROM harness_shared.memory_recall_stats
        WHERE surface = 'turn-start'
      `;
      const recallCount = Number(countRows[0]?.recall_count);
      const expectedRecallCount = process.env.PAPERCUSP_P006_RECALL_STATS === 'off' ? 0 : expectedRecallStatsCalls;
      console.log(
        '[P-006 telemetry]',
        JSON.stringify({ calls: recallStatsCalls, expectedRows: expectedRecallCount, persistedRows: recallCount }),
      );
      if (recallCount !== expectedRecallCount) {
        throw new Error(`recall telemetry row mismatch: expected ${expectedRecallCount}, got ${recallCount}`);
      }
    } catch (error) {
      setupError = error;
    }
  }, 900_000);

  afterAll(async () => {
    await disposeMemoryClient();
    // Dynamic telemetry imports may register after the renderer returns.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.allSettled([...writes]);
    await db?.cleanup();
  });

  it('measured every frozen query and preserved failures in every profile', () => {
    expect(setupError, String(setupError)).toBeUndefined();
    expect(profiles.map((p) => p.name)).toEqual(['normal-cold', 'normal-warm', 'burst-cold']);
    for (const profile of profiles) {
      expect(profile.rows.map((r) => r.queryId)).toEqual(loadGoldSetFixture().queries.map((q) => q.id));
      expect(profile.rows.length).toBeGreaterThanOrEqual(100);
      expect(
        profile.rows.some((r) => r.relevantDelivered.length > 0),
        profile.name,
      ).toBe(true);
    }
  });

  it('PERF-P-006: at least 95% of gold-eligible normal turns deliver useful recall within two seconds', () => {
    expect(setupError, String(setupError)).toBeUndefined();
    expect(profiles.length).toBe(3);
    for (const profile of profiles.filter((p) => p.concurrency === 1)) {
      expect(
        summarize(profile.rows).usefulRate,
        JSON.stringify({ profile: profile.name, ...summarize(profile.rows) }),
      ).toBeGreaterThanOrEqual(0.95);
    }
  });
});
