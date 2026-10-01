/**
 * P-006 delivery measurement: frozen real memory corpus -> real embedding/PG
 * hybrid search -> production renderer -> the unchanged two-second cache wait.
 * All memory, hygiene and telemetry SQL goes to a migrated throwaway org DB.
 * Memory-only profiles retain their frozen comparison. Combined profiles also
 * read the same frozen text as real work-items through the prose search engine.
 * This measures the current source build, not a deployed runtime.
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
  CanonicalVectorStore,
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
import * as recallStats from '../recall-stats';
import * as corpusRecallIo from '../corpus-recall-io';
import { buildMemoryContextBlock, pushSearchFloors } from '../injection';
import { getMemoryBlockBoundedResult, MEMORY_BLOCK_COLD_DEADLINE_MS } from '../injection-block-cache';
import { withMemoryTimeout } from '../op-deadline';
import { buildSidecarAwareEmbedder } from '../embed-sidecar-wiring';

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
vi.mock('../../session-brief', () => ({
  getSessionBriefAmbientExcludedRefs: async () => ({ available: true, refs: new Set<string>() }),
}));
// Advisory feature policy is pinned for this profile; retrieval floors, ranking,
// feedback, dedup and rendering remain the actual production implementations.
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));
const actualRecordRecallStats = recallStats.recordRecallStats;
const actualRecallCorpusContext = corpusRecallIo.recallCorpusContext;
const proseKeys = new Map<string, string>();
function installRecallStatsSpy() {
  // Concurrent dynamic imports can bypass vi.mock through Vitest's shared
  // manual-mock callstack. Observe the real export without replacing its module.
  vi.spyOn(recallStats, 'recordRecallStats').mockImplementation(
    (...args: Parameters<typeof actualRecordRecallStats>) => {
      recallStatsCalls += 1;
      const row = context.getStore();
      if (row) {
        row.telemetryCalls += 1;
        recallStatsCallsByQuery.set(row.queryId, (recallStatsCallsByQuery.get(row.queryId) ?? 0) + 1);
      }
      if (process.env.PAPERCUSP_P006_RECALL_STATS === 'off') return Promise.resolve();
      const p = actualRecordRecallStats(...args);
      writes.add(p);
      void p.finally(() => writes.delete(p));
      return p;
    },
  );
}

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
  corpusOutcome?: string;
  corpusDelivered?: string[];
  corpusEmbedderAvailable?: boolean;
  legs?: SearchLegStats;
  error?: string;
  work: Array<{ phase: string; startedMs: number; elapsedMs?: number; outcome?: 'ready' | 'error' }>;
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

async function traceWork<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const row = context.getStore();
  const span: Reading['work'][number] = { phase, startedMs: performance.now() };
  row?.work.push(span);
  try {
    const value = await run();
    span.outcome = 'ready';
    return value;
  } catch (error) {
    span.outcome = 'error';
    throw error;
  } finally {
    span.elapsedMs = performance.now() - span.startedMs;
  }
}

function unfinishedWork(row: Reading) {
  return row.work.filter((span) => !span.outcome).map((span) => ({
    phase: span.phase,
    elapsedMs: performance.now() - span.startedMs,
  }));
}

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
    work: [],
  };
  return context.run(row, async () => {
    const id = `delivery-${process.pid}-${++sequence}`;
    let build: Promise<string | null> | undefined;
    const started = performance.now();
    const result = await getMemoryBlockBoundedResult(
      workspaceId,
      id,
      (deadline) => {
        blockBuilds += 1;
        const buildStarted = performance.now();
        build = buildMemoryContextBlock({
          deadline: {
            signal: deadline.signal,
            run: (start, label, capMs) => traceWork(`deadline:${label}`, () => deadline.run(start, label, capMs)),
            remainingMs: () => deadline.remainingMs(),
            close: () => deadline.close(),
          },
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
    row.corpusDelivered = [...proseKeys]
      .filter(([ref]) => (result.block ?? '').includes(ref))
      .map(([, key]) => key);
    row.delivered = [...new Set([...row.delivered, ...row.corpusDelivered])];
    row.relevantDelivered = row.delivered.filter((key) => query.expected.includes(key));
    if (result.status !== 'ready' || row.callerMs > MEMORY_BLOCK_COLD_DEADLINE_MS) {
      console.log('[P-006 unfinished-work]', JSON.stringify({ queryId: row.queryId, phase,
        callerStatus: result.status, work: row.work, pending: unfinishedWork(row) }));
    }
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
      installRecallStatsSpy();
      // Observe the real SQL boundary without replacing retrieval. A search
      // wrapper can time out while its provider promise remains unsettled;
      // completed-duration totals alone must never label that as a SQL stall.
      const actualVectorSearch = CanonicalVectorStore.prototype.search;
      vi.spyOn(CanonicalVectorStore.prototype, 'search').mockImplementation(function (this: CanonicalVectorStore, ...args) {
        return traceWork(`vector-sql:limit=${args[1] ?? 5}`, () => actualVectorSearch.apply(this, args));
      });
      const actualLexicalSearch = CanonicalVectorStore.prototype.lexicalSearch;
      vi.spyOn(CanonicalVectorStore.prototype, 'lexicalSearch').mockImplementation(function (this: CanonicalVectorStore, ...args) {
        return traceWork('lexical-sql', () => actualLexicalSearch.apply(this, args));
      });
      vi.spyOn(corpusRecallIo, 'recallCorpusContext').mockImplementation(async (input) => {
        const row = context.getStore();
        if (!row?.phase.includes('combined')) return {
          block: null, lines: [], dropped: [], embedderAvailable: false,
          candidateCount: 0, outcome: 'disabled', rerank: 'nothing-to-reorder',
          legs: null, retrievalDepth: 0,
        };
        // Explicitly enable this leg; all retrieval, coverage, selection and
        // rendering stay real, against the same throwaway org database.
        const result = await traceWork('prose-corpus', () => actualRecallCorpusContext({
          ...input, skipFlagCheck: true,
        }));
        row.corpusOutcome = result.outcome;
        row.corpusEmbedderAvailable = result.embedderAvailable;
        return result;
      });
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
                return await traceWork(`embed:${hash(text).slice(0, 12)}`, () => resolved.embed(text, signal));
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
                const entries = await traceWork('hybrid-search', () => target.search(query, {
                  ...opts,
                  onLegStats: (legs) => {
                    if (row) row.legs = legs;
                    opts.onLegStats?.(legs);
                  },
                }));
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
      // Reuse the frozen representative corpus in the second store, with real
      // document embeddings and the registered work-item source's SQL/indexes.
      const proseEmbed = await buildSidecarAwareEmbedder('gemma', 'document');
      for (const [index, entry] of corpus.entries()) {
        const ref = `WI-${90_000_000 + index}`;
        const vector = await proseEmbed(entry.text);
        expect(vector.length).toBe(768);
        const now = Date.now();
        await db.adminSql`
          INSERT INTO harness_shared.work_items
            (workspace_id, harness_slug, feature_id, title, summary, status,
             item_kind, origin, ts, created_ts, updated_ts, embedding, embedding_mode)
          VALUES (${workspaceId}, 'delivery-corpus', ${ref}, ${entry.description ?? entry.key},
            ${entry.text}, 'open', 'task', 'local', ${now}, ${now}, ${now},
            ${JSON.stringify(vector)}::vector, 'gemma')
        `;
        proseKeys.set(ref, entry.key);
      }
      expect(await corpusRecallIo.warmCorpusEmbedder({ acquireBudgetMs: 60_000 })).toBe(true);
      console.log('[P-006 setup] combined corpus ready', JSON.stringify({ proseRows: proseKeys.size }));
      const queries = loadGoldSetFixture().queries;
      // Fail before the whole matrix when the representative search is stuck.
      // Keep this probe out of coverage/telemetry counts and discard its client
      // before each measured profile so it cannot manufacture a warm pass.
      const probe = queries.find((query) => query.id === 'lg-007')!;
      const preflight: Reading = {
        queryId: probe.id, phase: 'preflight', telemetryCalls: 0, className: probe.class,
        expected: probe.expected, status: 'unmeasured', callerMs: 0, buildMs: 0,
        availableMs: 0, searchMs: 0, embedMs: 0, embedCalls: 0,
        retrieved: [], delivered: [], relevantDelivered: [], work: [],
      };
      const controller = new AbortController();
      await context.run(preflight, async () => {
        try {
          await withMemoryTimeout(backend.search(probe.query, { scope, ...pushSearchFloors(),
            signal: controller.signal }), 'P-006 search preflight', MEMORY_BLOCK_COLD_DEADLINE_MS, controller);
        } finally {
          console.log('[P-006 preflight]', JSON.stringify({ queryId: probe.id,
            work: preflight.work, pending: unfinishedWork(preflight),
            recallStatsStrict: process.env.PAPERCUSP_P006_RECALL_STATS_STRICT === 'on' }));
        }
      });
      const sourcePaths = [
        'packages/operator-core/lib/memory/injection.ts',
        'packages/operator-core/lib/memory/injection-block-cache.ts',
        'packages/operator-core/lib/memory/recall-stats.ts',
        'packages/operator-core/lib/memory/op-deadline.ts',
        'packages/operator-core/lib/memory/corpus-recall-io.ts',
        'packages/operator-core/lib/memory/configure.ts',
        'packages/operator-core/lib/agent-tools/search/embedder.ts',
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
          isolation: 'throwaway org DB including hygiene and frozen prose work-items; advisory flags false; prose explicitly enabled only in combined profiles',
          cache: 'cold rendered-block cache per turn; cold client before each profile; warm query immediately primed',
        }),
      );
      for (const [name, concurrency, warm] of [
        ['normal-cold', 1, false],
        ['normal-warm', 1, true],
        ['burst-cold', 8, false],
        ['normal-combined', 1, false],
        ['burst-combined', 8, false],
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
              if (name === 'normal-cold' && index === 0) {
                expect(rows[index].callerMs, JSON.stringify(rows[index])).toBeLessThanOrEqual(MEMORY_BLOCK_COLD_DEADLINE_MS);
                expect(rows[index].error).toBeUndefined();
              }
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
      // measured profiles issue six recalls per gold query. Wait until every
      // fire-and-forget call has reached the mocked writer, then drain the
      // writer promises and prove serialization preserved one durable row per
      // recall. A latency-only pass could otherwise hide a queue that merely
      // shed telemetry to get out of the retrieval path.
      const expectedRecallStatsCalls = queries.length * 6;
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
          .filter((entry) => entry.calls !== 6);
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
    expect(profiles.map((p) => p.name)).toEqual([
      'normal-cold', 'normal-warm', 'burst-cold', 'normal-combined', 'burst-combined',
    ]);
    for (const profile of profiles) {
      expect(profile.rows.map((r) => r.queryId)).toEqual(loadGoldSetFixture().queries.map((q) => q.id));
      expect(profile.rows.length).toBeGreaterThanOrEqual(100);
      expect(
        profile.rows.some((r) => r.relevantDelivered.length > 0),
        profile.name,
      ).toBe(true);
    }
  });

  it('R-6: combined normal and burst turns execute real prose retrieval and deliver useful context', () => {
    expect(setupError, String(setupError)).toBeUndefined();
    const combined = profiles.filter((p) => p.name.includes('combined'));
    expect(combined).toHaveLength(2);
    for (const profile of combined) {
      expect(profile.rows.every((row) => row.corpusOutcome !== undefined), profile.name).toBe(true);
      expect(profile.rows.some((row) => row.corpusDelivered?.length), profile.name).toBe(true);
      expect(profile.rows.some((row) => row.corpusEmbedderAvailable), profile.name).toBe(true);
      expect(summarize(profile.rows).usefulRate,
        JSON.stringify({ profile: profile.name, ...summarize(profile.rows) })).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('PERF-P-006: at least 95% of gold-eligible normal turns deliver useful recall within two seconds', () => {
    expect(setupError, String(setupError)).toBeUndefined();
    expect(profiles.length).toBe(5);
    for (const profile of profiles.filter((p) => p.concurrency === 1)) {
      expect(
        summarize(profile.rows).usefulRate,
        JSON.stringify({ profile: profile.name, ...summarize(profile.rows) }),
      ).toBeGreaterThanOrEqual(0.95);
    }
  });
});
