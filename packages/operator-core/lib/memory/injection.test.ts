import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as recallStats from './recall-stats';
import * as corpusRecallIo from './corpus-recall-io';
import * as knowledgeSources from '../agent-tools/search/knowledge-sources';
import * as reportSources from '../agent-tools/search/report-source';
import * as corpusLedger from './corpus-surfaced-ledger';
import * as memoryLedger from './session-epoch-ledger';
import * as hiveSettings from '../hive-settings-store';
import * as packManagement from '../knowledge-packs/manage';
import * as coverageGate from '../search/coverage-gate';
import * as recallStaleness from './recall-staleness';
import * as flagServer from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { resetOperatorCacheForTests } from '../cache/instance';
import { contextSourceVersion, renderContextSourceUnit } from './temporal-render';
import { getOrgPg } from '@papercusp/db-org';
import { stageMemoryEmission, confirmMemoryEmission } from './session-epoch-ledger';
import { configureReadCursorStore, InMemoryReadCursorStore, resetReadCursorStore } from '../agent-tools/coordination/read-cursors';

describe('context reliability: complete source rendering', () => {
  it.each([
    ['late-negation', 'Do not execute without the receipt.'],
    ['approval', 'Only execute after explicit approval.'],
    ['exception', 'Except when the account is suspended.'],
    ['expiry', 'This authorization expires at midnight.'],
    ['supersession', 'This replaces the previous instruction.'],
  ])('context reliability R-4: %s entry', (_scenario, condition) => {
    const text = 'Execute the migration. ' + 'supporting detail '.repeat(70) + condition;
    const unit = renderContextSourceUnit(text, { kind: 'memory', ref: 'fixture', link: 'memory:fixture' }, 450);
    expect(unit.operative).toBe(false);
    expect(unit.text).toMatch(/^source-pointer /);
    expect(unit.text).not.toContain('Execute the migration');
    expect(unit.text).not.toContain(condition);
    expect(JSON.parse(unit.text.slice('source-pointer '.length))).toMatchObject({
      kind: 'memory', ref: 'fixture', revision: 'unknown', passage: 'retrieved-unit', omitted: true,
    });
    const complete = renderContextSourceUnit(text, { kind: 'memory', ref: 'fixture', link: 'memory:fixture' }, 10000);
    expect(complete.operative).toBe(true);
    expect(JSON.parse(complete.text.slice('source-evidence '.length))).toBe(text);
  });
});
import {
  MEMORY_INJECT_TIMEOUT_MS,
  MemoryTimeoutError,
  noteMemoryFailure,
  resetMemoryDegradedForTest,
  createMemoryWorkDeadline,
} from './op-deadline';

// db-org is mocked so the dedup/bump paths (getOrgPg().sql) are deterministic and
// never touch a real PG. `sqlMockState.rows` is the canned result the sql tag returns; the
// dedup test sets it to mark a memory id as recently-surfaced.
const sqlMockState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  statements: [] as string[],
  failure: null as Error | null,
  delayMs: 0,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: async (chunks: TemplateStringsArray | string) => {
      sqlMockState.statements.push(typeof chunks === 'string' ? chunks : chunks.join('?'));
      if (sqlMockState.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, sqlMockState.delayMs));
      if (sqlMockState.failure) throw sqlMockState.failure;
      return sqlMockState.rows;
    },
  }),
}));

vi.mock('./backend', () => ({
  getMemoryBackend: vi.fn(),
}));

// portable-identity-packages P-007: the session wearer's applied pack pins,
// driven per-test via `packPins.resolve`. Unset (the default) calls the REAL
// resolver, so every test that does not set it runs exactly as before.
const packPins = vi.hoisted(() => ({
  resolve: null as null | ((input: { workspaceId: string; ownerId: string | null | undefined }) => Promise<ReadonlySet<string>>),
  calls: [] as Array<{ workspaceId: string; ownerId: string | null | undefined }>,
}));
vi.mock('../blueprint/package-memory-visibility', async (orig) => {
  const actual = await orig<typeof import('../blueprint/package-memory-visibility')>();
  return {
    ...actual,
    wearerPackageResourcesOrEmpty: (...args: Parameters<typeof actual.wearerPackageResourcesOrEmpty>) => {
      if (!packPins.resolve) return actual.wearerPackageResourcesOrEmpty(...args);
      packPins.calls.push(args[1]);
      return packPins.resolve(args[1]);
    },
  };
});

// P-026: the push-path recall telemetry is fire-and-forget behind a dynamic
// import; mocking it lets the wiring be asserted (see the P-026 describe below).
const recordRecallStatsMock = vi.hoisted(() => vi.fn(async (_sql: unknown, _input: unknown) => {}));

// P-001: the corpus leg is behind a DYNAMIC import, so it is stubbed here and
// driven per-test via `corpusIoResult`.
//
// The default THROWS on purpose. `startCorpusLeg` swallows a fault into "the
// leg did not run", which is exactly the state every pre-P-001 test in this
// file already sat in (the real module needs a live search registry). Defaulting
// to a *successful* empty result would instead make every test in this file
// report a leg that ran BM25-only — which now emits a console.warn, and this
// package is fail-on-console.
type CorpusIoStub = Omit<corpusRecallIo.CorpusRecallResult, 'outcome' | 'rerank' | 'legs' | 'retrievalDepth'> &
  Partial<Pick<corpusRecallIo.CorpusRecallResult, 'outcome' | 'rerank' | 'legs' | 'retrievalDepth'>>;
let corpusIoResult: CorpusIoStub | null = null;
const recallCorpusContext = vi.fn(async (_input: corpusRecallIo.CorpusRecallInput): Promise<corpusRecallIo.CorpusRecallResult> => {
  if (!corpusIoResult) throw new Error('corpus leg not stubbed for this test');
  return { outcome: 'ok', rerank: 'nothing-to-reorder', legs: null, retrievalDepth: 0, ...corpusIoResult };
});

// P-003: the coverage snapshot read is behind a dynamic import of the SEARCH
// package's gate, so it is stubbed here and driven per-test via `coverageReport`.
//
// `null` (the default) makes `assessSearchCoverage` throw, which lands the gate
// in its fail-open catch — i.e. `gate: null`, rendering exactly as it did before
// P-003. That is the correct default for every pre-existing test in this file:
// none of them stub a coverage surface, and a fabricated HEALTHY default would
// assert the gate is inert while proving nothing about the degraded paths.
let coverageReport: unknown = null;
vi.mock('../search/coverage-gate', () => ({
  loadCoverageSnapshotCached: vi.fn(async () => new Map()),
  assessSearchCoverage: vi.fn(() => {
    if (!coverageReport) throw new Error('coverage not stubbed for this test');
    return coverageReport;
  }),
}));

/** A coverage report shaped like `assessSearchCoverage`'s, for one source. */
const coverageOf = (
  verdict: 'healthy' | 'degraded' | 'unknown' | 'not-semantic',
  over: { coverage?: number | null; embeddedRows?: number } = {},
) => {
  const a = {
    source: 'session_turn',
    verdict,
    coverage: over.coverage ?? (verdict === 'healthy' ? 0.999 : 0.01),
    recentCoverage: null,
    surfaces: [
      {
        surface: 'harness_shared.session_turns.text_embedding',
        observedAt: new Date(),
        eligibleRows: 100_000,
        embeddedRows: over.embeddedRows ?? (verdict === 'healthy' ? 99_900 : 9),
        pct: over.coverage ?? 0.999,
        recentPct: null,
        stale: false,
        ageMs: 60_000,
      },
    ],
    unknownSurfaces: [],
    note: '',
  };
  return {
    degraded: verdict === 'degraded' || verdict === 'unknown',
    degradedSources: verdict === 'degraded' ? ['session_turn'] : [],
    unknownSources: verdict === 'unknown' ? ['session_turn'] : [],
    perSource: [a],
    warning: null,
  };
};

/** A per-leg execution report shaped like the engine's `SearchLegs`. */
const legsWith = (lexicalCandidates: number) => {
  const leg = (candidates: number) => ({
    status: 'ran' as const,
    candidates,
    floored: 0,
    stage2Added: 0,
    callsRun: 1,
    callsFailed: 0,
    failures: [],
    blocked: null,
  });
  return { lexical: leg(lexicalCandidates), semantic: leg(6), degraded: false, warning: null };
};

// The harness registry backs the member→hive resolution (knowledge-packs
// P-004). Canned per-test via `registryProjects`; default empty ⇒ no hive pull.
// Jev (plan jev-decision-model-integration-2026-09-29): the owner's switch, driven
// per-test. The default is Off, which is every test above this file's Jev block.
const jev = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'shadow' | 'on',
  decide: null as null | ((request: { questions: Record<string, unknown> }, options?: unknown) => Promise<unknown>),
  clientBuilt: 0,
}));
vi.mock('./jev-settings', () => ({
  // jev-memory-gate imports the cap from here; a mock without it throws inside the
  // gate, which the injection path swallows as "no Jev call" (WI-10004485).
  JEV_MEMORY_TIMEOUT_MS: 800,
  getJevMode: vi.fn(async () => jev.mode),
  resolveJevMemoryInjection: vi.fn(async () => ({ mode: jev.mode, keyPresent: jev.mode !== 'off', effective: jev.mode })),
  ensureJevDecisionClient: vi.fn(() => {
    jev.clientBuilt += 1;
    return { decide: (request: { questions: Record<string, unknown> }, options?: unknown) => jev.decide!(request, options) };
  }),
}));

let registryProjects: Array<{ slug: string; harness_kind?: string; hive_slug?: string }> = [];
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: registryProjects })),
}));

import {
  buildMemoryContextBlock,
  prepareMemoryContextBlock,
  lastUserContext,
  MEMORY_INJECTION_COSINE_FLOOR,
  MEMORY_INJECTION_LEX_FLOOR,
  _resetCorpusLegHealthForTests,
} from './injection';
import { CORPUS_BLOCK_HEADING } from './corpus-recall';
import { getMemoryBackend } from './backend';
import { setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';

it('does no live memory or corpus IO for a frozen native assignment', async () => {
  setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: ['coord:whoami'],
    denyAmbientContext: true, reason: 'frozen benchmark', imposedBy: 'host' }));
  try {
    expect(await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'private', queryContext: 'find hidden answers',
      session: { sessionId: 'su-frozen', port: 'claim' } })).toBeNull();
    expect(getMemoryBackend).not.toHaveBeenCalled();
    expect(recallCorpusContext).not.toHaveBeenCalled();
  } finally { setSessionConfinementResolver(undefined); }
});
import { _resetForTests } from './bump-last-surfaced';

type Row = { id: string; text: string; kind?: string; metadata?: Record<string, unknown> };

// The neutral-backend mock (generalize-memory-backend-swappable D-003):
// `search` stamps each canned row with the scope it was queried under,
// mimicking the real backend's per-pool attribution.
//
// F-C (P-033, D-011): the push path now issues ONE multi-scope search, so the
// mock fans the canned rows out over EVERY requested scope — as the real
// backend does (mem0-backend.ts fans out per scope and merges). The aggregate
// is unchanged from the pre-F-C three-call era, where each call returned the
// same rows stamped with its own scope.
const mockBackend = (rows: Row[], availability: { ok: boolean; reason?: string } = { ok: true }) => ({
  name: 'fake',
  available: vi.fn(async () => availability),
  search: vi.fn(async (_q: string, opts: { scope: string | readonly string[]; signal?: AbortSignal }) => {
    const scopes = typeof opts.scope === 'string' ? [opts.scope] : [...opts.scope];
    return scopes.flatMap((scope) => rows.map((r) => ({ ...r, scope })));
  }),
});

const useBackend = (b: ReturnType<typeof mockBackend>): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

it('cancels upstream search when the existing injection phase deadline expires', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const backend = mockBackend([]);
  let upstream!: AbortSignal;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  backend.search.mockImplementation((_query, opts) => {
    upstream = opts.signal!;
    started();
    return new Promise((_resolve, reject) => {
      upstream.addEventListener('abort', () => reject(upstream.reason), { once: true });
    });
  });
  useBackend(backend);
  try {
    const block = buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'recall',
      harnessSlugs: ['papercusp'], potSlugs: [],
    });
    await didStart;
    await vi.advanceTimersByTimeAsync(MEMORY_INJECT_TIMEOUT_MS + 1);
    const timedOutBlock = await block;
    expect(timedOutBlock).toContain('memory leg: timed-out');
    expect(timedOutBlock).toContain('authorized memory reader');
    expect(timedOutBlock).not.toContain('memory:search');
    expect(upstream.aborted).toBe(true);
    expect(upstream.reason).toBeInstanceOf(MemoryTimeoutError);
    expect(backend.search).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    log.mockRestore();
    resetMemoryDegradedForTest();
  }
});

it('recovers useful recall on the next turn after a shared prompt budget expires', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const budgetMs = 2000;
  const firstDeadline = createMemoryWorkDeadline(budgetMs);
  const backend = mockBackend([{ id: 'recovered', text: 'The http2 transport uses stream cancellation.' }]);
  let upstream!: AbortSignal;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  backend.search.mockImplementationOnce((_query, opts) => {
    upstream = opts.signal!;
    started();
    return new Promise((_resolve, reject) => {
      upstream.addEventListener('abort', () => reject(upstream.reason), { once: true });
    });
  });
  useBackend(backend);
  let nextDeadline: ReturnType<typeof createMemoryWorkDeadline> | undefined;
  try {
    const first = buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'first http2 query',
      harnessSlugs: ['papercusp'], potSlugs: [], deadline: firstDeadline,
    });
    await didStart;
    await vi.advanceTimersByTimeAsync(budgetMs + 1);
    await expect(first).resolves.toContain('memory leg: timed-out');
    expect(upstream.aborted).toBe(true);
    expect(upstream.reason).toBeInstanceOf(MemoryTimeoutError);

    // No latch reset, cooldown wait, or budget increase between turns.
    nextDeadline = createMemoryWorkDeadline(budgetMs);
    const next = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'next http2 query',
      harnessSlugs: ['papercusp'], potSlugs: [], deadline: nextDeadline,
    });
    expect(next).toContain('id=recovered');
    expect(next).not.toContain('memory leg: timed-out');
    expect(backend.available).toHaveBeenCalledTimes(2);
    expect(backend.search).toHaveBeenCalledTimes(2);
  } finally {
    firstDeadline.close();
    nextDeadline?.close();
    vi.useRealTimers();
    log.mockRestore();
    resetMemoryDegradedForTest();
  }
});

it('keeps useful memory when the concurrently running corpus exhausts their shared budget', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Real module imports and hygiene work must actually complete before the
  // deadline; jumping a fake clock can expire while those imports are pending.
  const deadline = createMemoryWorkDeadline(1000);
  useBackend(mockBackend([{ id: 'timely', text: 'The http2 transport uses stream cancellation.' }]));
  recallCorpusContext.mockImplementationOnce(async () => new Promise(() => {}));
  try {
    const build = buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'http2 transport', deadline });
    const block = await build;
    expect(block).toContain('id=timely');
    expect(block).toContain('corpus leg: timed-out');
    expect(block).not.toContain('memory leg: timed-out');
  } finally { deadline.close(); log.mockRestore(); warn.mockRestore(); resetMemoryDegradedForTest(); }
});

it('preserves ready healthy corpus when memory availability exceeds the native mid-turn deadline', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const deadline = createMemoryWorkDeadline(1000);
  const backend = mockBackend([]);
  backend.available.mockImplementationOnce(() => new Promise(() => {}));
  useBackend(backend);
  corpusIoResult = {
    block: null,
    lines: [{ line: '- [doc doc:healthy-procedure] Retain the snapshot.', score: 1,
      handle: { kind: 'doc', ref: 'doc:healthy-procedure', query: ['diagnostic evidence'],
        resolve: 'docs:get { slugs: ["healthy-procedure"] }' } }],
    dropped: [], outcome: 'ok', retrievalDepth: 24, rerank: 'nothing-to-reorder',
    embedderAvailable: true, candidateCount: 1,
  };
  try {
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws',
      queryContext: 'diagnostic evidence', session: { sessionId: 'native-mid-turn-wall', port: 'mid-turn' }, deadline });
    expect(block).toContain('healthy-procedure');
    expect(block).toContain('memory leg: timed-out');
    expect(backend.search).not.toHaveBeenCalled();
  } finally { deadline.close(); log.mockRestore(); resetMemoryDegradedForTest(); }
});

it('charges availability and search to one budget and cancels the remaining search', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const deadline = createMemoryWorkDeadline(100);
  const backend = mockBackend([]);
  backend.available.mockImplementation(async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 70)));
  let searchSignal: AbortSignal | undefined;
  backend.search.mockImplementation(async (_query, opts) => {
    searchSignal = opts.signal;
    return new Promise((resolve) => setTimeout(() => resolve([]), 70));
  });
  useBackend(backend);
  try {
    const build = buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'http2', deadline });
    await vi.advanceTimersByTimeAsync(101);
    expect(await build).toContain('memory leg: timed-out');
    expect(searchSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.search).toHaveBeenCalledOnce();
  } finally { deadline.close(); log.mockRestore(); vi.useRealTimers(); resetMemoryDegradedForTest(); }
});

beforeEach(() => {
  setSessionConfinementResolver(() => null);
  // Vitest's manual-mock callstack is shared across concurrent dynamic imports.
  // Spy on resolved exports so burst recalls cannot bypass these fixture seams.
  vi.spyOn(recallStats, 'recordRecallStats').mockImplementation(recordRecallStatsMock);
  vi.spyOn(corpusRecallIo, 'recallCorpusContext')
    .mockImplementation(recallCorpusContext);
  vi.mocked(getMemoryBackend).mockReset();
  recordRecallStatsMock.mockClear();
  recallCorpusContext.mockClear();
  // The Jev gate reuses answers through the process-wide operator cache
  // (WI-10004485); each test mocks its own answers, so start every test empty.
  resetOperatorCacheForTests();
  jev.mode = 'off';
  jev.decide = null;
  jev.clientBuilt = 0;
  sqlMockState.rows = [];
  sqlMockState.statements = [];
  sqlMockState.failure = null;
  sqlMockState.delayMs = 0;
  registryProjects = [];
  corpusIoResult = null;
  coverageReport = null;
  packPins.resolve = null;
  packPins.calls = [];
  _resetForTests();
  _resetCorpusLegHealthForTests();
});

it('attributes slow post-search database phases instead of hiding them inside postMs', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  sqlMockState.delayMs = 260;
  useBackend(mockBackend([{
    id: '11111111-1111-4111-8111-111111111111',
    text: 'phase attribution guard',
  }]));
  try {
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'trace the post-search path',
      harnessSlugs: ['papercusp'], potSlugs: [],
      session: { sessionId: 'phase-attribution-session', port: 'turn-start' },
    });
    expect(block).toContain('phase attribution guard');
    const phaseLine = log.mock.calls
      .map((args) => args.map(String).join(' '))
      .find((line) => line.includes('[memory-injection] phases'));
    const phases = Object.fromEntries(
      Array.from(phaseLine?.matchAll(/(\w+Ms)=(\d+)/g) ?? [], (match) => [match[1], Number(match[2])]),
    );
    expect(phases.stalenessMs).toBeDefined();
    expect(phases.feedbackMs).toBeGreaterThanOrEqual(200);
    expect(phases.dedupMs).toBeGreaterThanOrEqual(450);
    expect(phases.renderMs).toBeDefined();
  } finally {
    log.mockRestore();
  }
});

/**
 * context-injection-audit-2026-07-28 P-032 (F-B / D-010) — the CEILING guard.
 *
 * The push path must be able to return FEWER than K, including ZERO. It could
 * not: under the hybrid default `floored-union` the lexical leg admits hits on
 * minLexScore ALONE, so the cosine leg could return zero and the block still came
 * back full — 97% of turn-start recalls returned exactly the pool-limit sums with
 * a 0.0% zero-hit rate (D-005). The fix is the fusion MODE, not any constant:
 * `cosine-gated` seeds candidates only from cosine hits.
 *
 * These tests pin that the push path REQUESTS the gated mode. The mode's actual
 * short-circuit semantics belong to the hybrid backend and are pinned there
 * (hybrid-backend.test.ts) — asserting them against this file's fake backend
 * would only prove the fake ignores the flag, which is exactly the false-green
 * this comment exists to prevent.
 */
describe('push path requests a relevance-gated ceiling (P-032 / F-B)', () => {
  const optsOf = (b: ReturnType<typeof mockBackend>, i: number) =>
    b.search.mock.calls[i]![1] as { fusionMode?: string; minScore?: number; limit?: number };
  const diversifyOf = (b: ReturnType<typeof mockBackend>, i: number) =>
    (b.search.mock.calls[i]![1] as { diversify?: { lambda?: number } }).diversify;

  // F-C (P-033, D-011) collapsed the three per-pool searches into ONE
  // multi-scope search, so "every pool is gated" is now "the one call covering
  // every pool is gated" — the guarantee is unchanged, its shape is not.
  it('passes fusionMode cosine-gated on the search covering EVERY pool (user, harness, hive)', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      potSlugs: ['hivey'],
    });
    expect(backend.search).toHaveBeenCalledTimes(1);
    expect(optsOf(backend, 0).fusionMode).toBe('cosine-gated');
    expect(backend.search.mock.calls[0]![1]!.scope).toEqual([
      'u1',
      'harness:papercusp',
      'hive:hivey',
    ]);
  });

  /**
   * P-046's GUARD, at the seam it actually has to hold (P-044 / F-L).
   *
   * `recall-query.test.ts` pins that `lexicalQueryText` COMPOSES a query
   * carrying the signals. That is necessary and not sufficient: a refactor
   * could keep that function perfect while this file quietly stopped passing
   * `lexicalQuery` to the backend, and every test in both files would still be
   * green while retrieval silently reverted to user-text-only on both legs.
   * That is exactly the failure mode P-046 exists to catch — "every existing
   * test asserts on what retrieval RETURNS, none on what it ASKS".
   *
   * Note what is asserted about the COSINE query: it stays byte-identical to
   * the human's words. Under P-044 that is the design, not the bug (D-041
   * measured identifiers diluting that vector), so the divergence P-046 wants
   * lives on the lexical leg.
   */
  it('ISSUES the signal-bearing query to the lexical leg — not just composes it', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: {
        userText: 'continue where you left off',
        agentSignals: {
          workItem: { id: 'WI-6512' },
          trajectory: { paths: ['apps/operator-vite/src/components/HistoryDropdown.tsx'] },
        },
      },
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    });
    const [query, opts] = backend.search.mock.calls[0]! as [string, { lexicalQuery?: string }];
    expect(query).toBe('continue where you left off');
    expect(opts.lexicalQuery).toBe('continue where you left off WI-6512 HistoryDropdown');
    expect(opts.lexicalQuery).not.toBe(query);
  });

  // WI-10004485: the turn-start port's latency opt-in must reach the backend —
  // and must stay OFF for every caller that did not ask (the strict cosine-gated
  // series remains the default contract).
  it('forwards overlapGatedLexical to the backend only when the caller opts in', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    const base = {
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    };
    await buildMemoryContextBlock({ ...base, overlapGatedLexical: true });
    await buildMemoryContextBlock(base);
    expect(backend.search).toHaveBeenCalledTimes(2);
    expect(backend.search.mock.calls[0]![1]).toMatchObject({
      fusionMode: 'cosine-gated',
      overlapGatedLexical: true,
    });
    expect(backend.search.mock.calls[1]![1]).not.toHaveProperty('overlapGatedLexical');
  });

  it('omits lexicalQuery entirely with no signals, so both legs share one query', async () => {
    // The no-signals turn must stay byte-identical to pre-P-044 — that is what
    // keeps the P-041 baseline comparable across the change.
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    });
    expect(backend.search.mock.calls[0]![1]).not.toHaveProperty('lexicalQuery');
  });

  // The floor is NOT the fix for the saturation bug and must not be quietly
  // retuned as if it were: the saturating hits never came through the cosine leg
  // (D-008), so moving the floor changes which cosine hits survive, not how many
  // results come back.
  //
  // ⚠ Asserted against the EXPORTED constant, never a copied literal. This test
  // used to hard-code 0.45 and was stranded the moment D-058 recalibrated the
  // floor to 0.58 — the exact "copied magic number" failure the export exists to
  // prevent (see MEMORY_INJECTION_COSINE_FLOOR's doc-comment). What this pins is
  // the WIRING — that the push path forwards the calibrated floor to the backend
  // unchanged — which still fails loudly if minScore goes missing, gets swapped
  // for the lexical bar, or is hardcoded in the request path. The VALUE itself is
  // governed by the calibration sweep + D-058, not by this assertion.
  it('forwards the calibrated cosine floor unchanged — the mode is the fix, not the floor', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    });
    expect(optsOf(backend, 0).minScore).toBe(MEMORY_INJECTION_COSINE_FLOOR);
  });

  // F-D (P-034, D-014). Only the REQUEST is asserted here, for the same reason
  // the header gives for fusionMode: the re-rank itself is the backend's, and
  // asserting its effect against this file's fake would prove only that the fake
  // ignores the option. The behavior is pinned in hybrid-backend.test.ts.
  it('requests the diversity re-rank — nothing else in the chain penalizes redundancy', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'], potSlugs: [],
    });
    expect(diversifyOf(backend, 0)).toEqual({ lambda: 0.7 });
  });

  it('PAPERCUSP_MEMORY_DIVERSITY_LAMBDA=1 omits the option entirely — λ=1 is a no-op, so do not pay for it', async () => {
    const prev = process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA;
    process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA = '1';
    try {
      const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
      useBackend(backend);
      await buildMemoryContextBlock({
        userId: 'u1', workspaceId: 'ws', queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'], potSlugs: [],
      });
      expect(diversifyOf(backend, 0)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA;
      else process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA = prev;
    }
  });

  it('returns null when the pools come back empty — a zero-hit turn injects NOTHING', async () => {
    useBackend(mockBackend([]));
    const block = await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'a query nothing is relevant to',
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    });
    expect(block).toBeNull();
  });

  it('honours the PAPERCUSP_MEMORY_FUSION_MODE revert switch', async () => {
    const prev = process.env.PAPERCUSP_MEMORY_FUSION_MODE;
    process.env.PAPERCUSP_MEMORY_FUSION_MODE = 'floored-union';
    try {
      const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
      useBackend(backend);
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
      });
      expect(optsOf(backend, 0).fusionMode).toBe('floored-union');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_FUSION_MODE;
      else process.env.PAPERCUSP_MEMORY_FUSION_MODE = prev;
    }
  });
});

describe('temporal-lite recall rendering (WI-40101)', () => {
  it('passes the explicit history opt-in and labels a superseded row before its body', async () => {
    const backend = mockBackend([
      {
        id: 'old-memory',
        text: 'Gemma is the default embedder',
        kind: 'project',
        metadata: {
          validity: {
            status: 'superseded',
            invalid_at: '2026-07-10T15:45:00.000Z',
            superseded_by: 'new-memory',
          },
        },
      },
      {
        id: 'current-memory',
        text: 'Harrier is the default embedder',
        kind: 'project',
        metadata: { validity: { status: 'current', invalid_at: null } },
      },
    ]);
    useBackend(backend);

    const block = await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'default embedder',
      includeSuperseded: true,
    });

    expect(backend.search.mock.calls[0]![1]).toMatchObject({ includeSuperseded: true });
    expect(block).toContain('[SUPERSEDED 2026-07-10] Gemma is the default embedder');
    expect(block).toContain('Harrier is the default embedder');
    expect(block).not.toContain('[SUPERSEDED date unknown] Harrier');
  });
});

/**
 * context-injection-audit-2026-07-28 P-033 (F-C / D-011) — the NO-QUOTA guard.
 *
 * The pools were budgeted INVERSELY to where knowledge lives: 6 slots to the
 * 487-memory CROSS-PROJECT personal pool, 3 to the 770-memory on-topic harness
 * pool. F-C deletes the per-pool reservations rather than retuning them (P-033
 * explicitly forbids simply raising the harness quota).
 *
 * The reason this had to become ONE search is subtle and worth pinning, because
 * a future change could "simplify" it back into three calls and silently
 * reintroduce the quota: the score handed back is RRF, a function of rank WITHIN
 * ONE CALL. Across separate calls two pools' rank-1 hits score identically, so
 * there is nothing sound to allocate on and any cross-pool ordering degenerates
 * into a fixed priority — a quota by another name.
 */
describe('pool budgets are a single shared ceiling, not per-pool quotas (P-033 / F-C)', () => {
  it('issues ONE search over the union of scopes, not one per pool', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'q',
      harnessSlugs: ['papercusp', 'other'],
      potSlugs: ['hivey'],
    });
    expect(backend.search).toHaveBeenCalledTimes(1);
    const opts = backend.search.mock.calls[0]![1] as { scope: string[]; limit: number };
    expect(opts.scope).toEqual(['u1', 'harness:papercusp', 'harness:other', 'hive:hivey']);
    // ONE ceiling for all of them — not 6 + 3 + 3 spent per pool.
    expect(opts.limit).toBe(12);
  });

  it('lets a SINGLE pool fill the whole block — no pool holds a reservation', async () => {
    // Only the harness pool returns anything. Under the old quotas it could
    // never exceed 3 however relevant its hits were; now it competes for all 12.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `h${i}`,
      text: `harness fact number ${i} about the deploy pipeline`,
      kind: 'reference',
    }));
    const backend = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async (_q: string, opts: { scope: string | readonly string[] }) => {
        const scopes = typeof opts.scope === 'string' ? [opts.scope] : [...opts.scope];
        return scopes.flatMap((scope) =>
          scope.startsWith('harness:') ? rows.map((r) => ({ ...r, scope })) : [],
        );
      }),
    };
    useBackend(backend as unknown as ReturnType<typeof mockBackend>);
    const block = await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'deploy pipeline',
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    });
    // All 8 render: the old PER_HARNESS_LIMIT=3 would have capped this at 3.
    for (let i = 0; i < 8; i++) expect(block).toContain(`harness fact number ${i}`);
  });

  it('renders in the backend RELEVANCE order, not in pool order', async () => {
    // The backend returns one ranked list; the harness hit outranks the user
    // hit. Pre-F-C the render was strictly user-then-harness, so the user hit
    // would lead regardless of rank — and since the char budget truncates in
    // render order, that ordering WAS the real allocator.
    const backend = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async () => [
        { id: 'r1', text: 'the most relevant fact', kind: 'reference', scope: 'harness:papercusp' },
        { id: 'r2', text: 'a less relevant personal note', kind: 'preference', scope: 'u1' },
      ]),
    };
    useBackend(backend as unknown as ReturnType<typeof mockBackend>);
    const block = await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'q',
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    });
    expect(block!.indexOf('the most relevant fact')).toBeLessThan(
      block!.indexOf('a less relevant personal note'),
    );
  });

  it('still yields hive-PACK rows last, whatever their rank (preserved trust tier)', async () => {
    // The one exception F-C keeps: packs are the most numerous and least
    // turn-specific, so they lose the budget race even when they rank first.
    const backend = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async () => [
        {
          id: 'p1',
          text: 'a seeded pack learning',
          kind: 'reference',
          scope: 'hive:hivey',
          metadata: { source: 'pack', pack_id: 'pk1' },
        },
        { id: 'o1', text: 'an organic harness fact', kind: 'reference', scope: 'harness:papercusp' },
      ]),
    };
    useBackend(backend as unknown as ReturnType<typeof mockBackend>);
    const block = await buildMemoryContextBlock({
      userId: null,
      workspaceId: 'ws',
      queryContext: 'q',
      harnessSlugs: ['papercusp'],
      potSlugs: ['hivey'],
    });
    expect(block!.indexOf('an organic harness fact')).toBeLessThan(
      block!.indexOf('a seeded pack learning'),
    );
  });

  it('treats input.limit as the TOTAL ceiling across pools, not the user pool alone', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'q',
      harnessSlugs: ['papercusp'],
      potSlugs: ['hivey'],
      limit: 3,
    });
    expect(
      (backend.search.mock.calls[0]![1] as { scope: string[]; limit: number }).limit,
    ).toBe(3);
  });
});

/**
 * context-injection-audit-2026-07-28 P-026 — the WIRING guard.
 *
 * recall-stats.ts can grow the richest per-pool schema in the world and it
 * changes nothing if the push path keeps calling it with a flat `entries` list:
 * the column stays NULL in production and the measurement every other fix in
 * that plan is judged by silently does not exist. This block fails if the call
 * site regresses to a flat record — the failure that is invisible in staging,
 * because a flat write succeeds just as quietly as a per-pool one.
 */
describe('push-path recall telemetry is recorded PER POOL (P-026)', () => {
  /** Flush the fire-and-forget telemetry task (dynamic import + insert). */
  // Let the FIRE-AND-FORGET telemetry write land. It is `void`-ed on purpose, so
  // there is nothing to await — the test has to yield until it completes.
  //
  // ⚠ MACROTASK turns, not `Promise.resolve()` microtasks. The writer does
  // `await import('./recall-stats')`, and a dynamic import does not settle by
  // spinning the microtask queue however many times you spin it. The old
  // 5-microtask version passed only because the write was START­ED early in
  // buildMemoryContextBlock and had the whole filter chain's awaits to resolve
  // in — i.e. it was coupled to WHERE the call sat in the function, not to the
  // work it does. P-002 moved that write into a `finally` (so every exit path
  // records exactly one row) and the coupling surfaced as 7 failures that look
  // like assertion breaks and are really a hidden timing dependency.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('passes a per-pool breakdown, never a flat entries list', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      potSlugs: ['hivey'],
    });
    await flush();

    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
    const input = recordRecallStatsMock.mock.calls[0]![1] as {
      pools?: Record<string, { entries: unknown[]; limit: number; scopes: string[] }>;
      entries?: unknown[];
    };
    // The collapse must not come back.
    expect(input.entries).toBeUndefined();
    expect(input.pools).toBeDefined();
    expect(Object.keys(input.pools!).sort()).toEqual(['harness', 'hive', 'user']);
  });

  // EI-19920080383279759 (gate-2, same class as WI-6933/WI-7154): a pool with
  // NOTHING to key on (no userId, or an explicitly-suppressed harness/hive
  // fan-out) was never queried at all — recording it as a pool row with
  // scopes:[] is indistinguishable, downstream, from a pool that WAS asked
  // and genuinely found nothing, which is exactly the "100% empty-scope,
  // 100% zero-hit" shape the watchdog keeps re-flagging as a caller bug. The
  // key must be OMITTED, not recorded empty — this is what the Mug's
  // userId-less 'brief' surface (mug-brief-launch.ts: "the Mug is not a
  // user") hits on every single wake.
  it('omits the user pool entirely — never records it empty-scoped — when there is no userId to key on', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: null,
      workspaceId: 'ws',
      queryContext: 'mug brief',
      harnessSlugs: ['papercusp'],
      potSlugs: ['hivey'],
    });
    await flush();

    const { pools } = recordRecallStatsMock.mock.calls[0]![1] as {
      pools: Record<string, { entries: unknown[]; limit: number; scopes: string[] }>;
    };
    expect(pools.user).toBeUndefined();
    expect(Object.keys(pools).sort()).toEqual(['harness', 'hive']);
  });

  it('omits the harness/hive pools when their fan-out was explicitly suppressed ([])', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: [],
      potSlugs: [],
    });
    await flush();

    const { pools } = recordRecallStatsMock.mock.calls[0]![1] as {
      pools: Record<string, { entries: unknown[]; limit: number; scopes: string[] }>;
    };
    expect(Object.keys(pools).sort()).toEqual(['user']);
  });

  it('stamps each pool with the budget and the SCOPE KEYS it actually queried', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      potSlugs: ['hivey'],
      limit: 6,
    });
    await flush();

    const { pools } = recordRecallStatsMock.mock.calls[0]![1] as {
      pools: Record<string, { entries: unknown[]; limit: number; scopes: string[] }>;
    };
    expect(pools.user).toMatchObject({ limit: 6, scopes: ['u1'] });
    // The gate-2 detector: the harness pool records the slug it was keyed on,
    // so a pool queried under a slug nothing writes to is identifiable later.
    expect(pools.harness!.scopes).toEqual(['harness:papercusp']);
    expect(pools.hive!.scopes).toEqual(['hive:hivey']);
  });

  it('records a pool that returned ZERO — the row a flat hit_count could not express', async () => {
    // Backend returns rows for the user scope only; harness/hive come back empty.
    const backend = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async (_q: string, opts: { scope: string | readonly string[] }) => {
        const scope = typeof opts.scope === 'string' ? opts.scope : opts.scope[0]!;
        return scope.startsWith('harness:') || scope.startsWith('hive:')
          ? []
          : [{ id: 'u-only', text: 'personal', scope }];
      }),
    };
    useBackend(backend as unknown as ReturnType<typeof mockBackend>);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    });
    await flush();

    const { pools } = recordRecallStatsMock.mock.calls[0]![1] as {
      pools: Record<string, { entries: unknown[]; scopes: string[] }>;
    };
    expect(pools.user!.entries).toHaveLength(1);
    expect(pools.harness!.entries).toHaveLength(0);
    expect(pools.harness!.scopes).toEqual(['harness:papercusp']);
  });

  it('stamps workspace and pot so the telemetry is sliceable (dead since migration 290)', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws-42',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      potSlugs: [],
    });
    await flush();
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
      workspaceId: 'ws-42',
      potSlug: 'papercusp',
    });
  });

  /**
   * P-002 / migration 758 — the ADMISSION FUNNEL.
   *
   * The row is assembled from what the INDEX returned, and six filter stages sit
   * between that and what the agent receives. Before this, nothing recorded the
   * delivered end at all, so "12 hits" and "delivered 2 lines" were the same row.
   */
  describe('records the admission funnel, not just what the index returned', () => {
    it('separates what came back from what was DELIVERED, and says where the rest went', async () => {
      // Three distinct entries, a budget that fits roughly one line.
      useBackend(
        mockBackend([
          { id: 'm1', text: 'alpha alpha alpha alpha alpha alpha alpha alpha' },
          { id: 'm2', text: 'bravo bravo bravo bravo bravo bravo bravo bravo' },
          { id: 'm3', text: 'charlie charlie charlie charlie charlie charlie' },
        ]),
      );
      const block = await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
        budgetChars: 160,
      });
      await flush();

      expect(block).toContain('more learnings withheld this turn');
      expect(block).toContain('authorized memory reader');
      expect(block).not.toContain('memory:search');

      const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
        admission: { returned: number; admitted: number; truncated: boolean; dropped: Record<string, number> };
      };
      // The whole point: returned and admitted DIVERGE...
      expect(admission.returned).toBeGreaterThan(0);
      expect(admission.admitted).toBeLessThan(admission.returned);
      expect(admission.truncated).toBe(true);
      expect(admission.dropped.budget).toBeGreaterThan(0);
      // ...and the funnel ACCOUNTS FOR THE GAP — every returned row is either
      // admitted or attributed to the stage that dropped it. This is the
      // invariant, not any particular count: a stage added later that forgets to
      // record its drops breaks this sum, which is exactly when we want to know.
      const totalDropped = Object.values(admission.dropped).reduce((a, b) => a + b, 0);
      expect(admission.admitted + totalDropped).toBe(admission.returned);
    });

    /**
     * D-081. `truncated: true` is reached by two situations that call for
     * OPPOSITE fixes — an exhausted budget (raise the budget) and a remainder of
     * individually-oversized entries (the MAX_ENTRY_CHARS clamp is the real
     * ceiling; raising the budget buys little). Before `spent`/`budgetChars`
     * they were indistinguishable in telemetry, which is why P-024's own stated
     * acceptance criteria (`dropped.budget` + `truncated`) could not settle the
     * question P-024 asks.
     *
     * The assertion is therefore NOT "the fields are populated" — it is that the
     * two cases now SEPARATE. A future change that makes them read alike again
     * fails here.
     */
    it('records spent against the budget, so a budget-bound cut is distinguishable from a clamp-bound one', async () => {
      // CASE A — budget-bound: many small entries, so the packer fills the
      // budget and cuts a tail of entries that would each have fit alone.
      //
      // ⚠ The texts must be lexically DISTINCT, not `alpha0..alpha19`:
      // collapseNearDuplicates runs BEFORE the budget stage, so near-identical
      // strings are removed as duplicates and the budget never binds — the test
      // would then pass for the wrong reason (or fail confusingly).
      const distinct = [
        'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
        'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
        'quebec', 'romeo', 'sierra', 'tango',
      ];
      useBackend(
        mockBackend(distinct.map((w, i) => ({ id: `a${i}`, text: `${w} ${w}` }))),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
        budgetChars: 200,
      });
      await flush();

      // CASE B — clamp-bound: one small entry lands, then every remaining entry
      // is individually larger than the whole budget, so none can ever fit. The
      // block is truncated with most of the budget UNSPENT.
      // Distinct fill characters for the same reason as CASE A — five identical
      // 400-char strings would collapse to one before the budget ever saw them.
      useBackend(
        mockBackend([
          { id: 'b0', text: 'tiny' },
          ...['p', 'q', 'r', 's', 't'].map((c, i) => ({ id: `b${i + 1}`, text: c.repeat(400) })),
        ]),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
        budgetChars: 200,
      });
      await flush();

      type Funnel = { truncated: boolean; spent?: number; budgetChars?: number };
      const caseA = (recordRecallStatsMock.mock.calls[0]![1] as { admission: Funnel }).admission;
      const caseB = (recordRecallStatsMock.mock.calls[1]![1] as { admission: Funnel }).admission;

      // The budget each was packed against is carried, so a historical row stays
      // interpretable after the constant moves.
      expect(caseA.budgetChars).toBe(200);
      expect(caseB.budgetChars).toBe(200);

      // Both hit the SAME terminal signal — this is the ambiguity being fixed.
      expect(caseA.truncated).toBe(true);
      expect(caseB.truncated).toBe(true);

      // ...and `spent` is what tells them apart. A is budget-bound: it consumed
      // most of what it was given. B is clamp-bound: it stopped far short.
      // Asserted as a RELATION rather than exact chars, because the rendered
      // line carries a scope/id prefix whose width is not this test's subject.
      expect(caseA.spent).toBeGreaterThan(100);
      expect(caseA.spent).toBeLessThanOrEqual(200);
      expect(caseB.spent).toBeLessThan(100);
      expect(caseA.spent!).toBeGreaterThan(caseB.spent!);
    });

    /**
     * P-024 / D-090 recurrence guard. D-089 established the model this pins:
     * REACH IS THE QUOTIENT of the budget and the per-entry cost, so halving
     * MAX_ENTRY_CHARS (900 -> 450) roughly DOUBLES the admitted count at the same
     * context spend — which is why the owner chose the clamp over doubling the
     * budget, the lever that buys the same slots for ~2x the tokens.
     *
     * Deliberately asserts the BEHAVIOUR, not the constant. A test reading
     * `expect(MAX_ENTRY_CHARS).toBe(450)` would restate the source and pass for a
     * change that re-broke reach via the prefix, the packer, or the budget. This
     * fails if the clamp drifts back up: at the real 4,000-char turn-start budget,
     * the pre-D-090 clamp admitted ~4.4 entries and this admits ~8.7, so the
     * threshold sits between the two regimes and cannot be satisfied by the old one.
     *
     * Texts are lexically DISTINCT for the same reason CASE A/B above are:
     * collapseNearDuplicates runs BEFORE the budget stage, so near-identical
     * strings vanish as duplicates and the budget never binds — the test would
     * then pass for the wrong reason.
     */
    it('halving the per-entry clamp roughly doubles admitted entries at the same budget (D-090)', async () => {
      const words = [
        'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot',
        'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
      ];
      // Each entry is far larger than the clamp, so every admitted line costs
      // exactly clamp + prefix — the quotient's denominator, held constant.
      useBackend(
        mockBackend(words.map((w, i) => ({ id: `q${i}`, text: `${w} `.repeat(500) }))),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
        budgetChars: 4000,
      });
      await flush();

      const funnel = (
        recordRecallStatsMock.mock.calls[0]![1] as {
          admission: { admitted: number; budgetChars?: number };
        }
      ).admission;

      expect(funnel.budgetChars).toBe(4000);
      // ~8.7 slots at a 450 clamp; ~4.4 at the old 900. Between the two regimes.
      expect(funnel.admitted).toBeGreaterThanOrEqual(7);
    });

    /**
     * An oversized source stays addressable without printing a potentially
     * misleading prefix. Its pointer is provenance, not operative evidence.
     */
    it('an oversized entry retains provenance without an imperative prefix', async () => {
      useBackend(mockBackend([{ id: 'long1', text: `mnemonic ${'detail '.repeat(400)}` }]));
      const block = await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
        budgetChars: 4000,
      });
      await flush();

      expect(block).toContain('source-pointer');
      expect(block).not.toContain('memory:search');
      expect(block).toContain('id=long1');
      expect(block).toContain('"omitted":true');
      expect(block).not.toContain('mnemonic');
    });

    /**
     * The first row follows the same complete-unit budget as later rows. A
     * tiny budget yields no source text rather than an incomplete instruction.
     */
    it('never admits an oversized first row above the budget', async () => {
      useBackend(
        mockBackend([
          { id: 'big1', text: 'y'.repeat(400) },
          { id: 'big2', text: 'z'.repeat(400) },
        ]),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
        budgetChars: 50,
      });
      await flush();

      const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
        admission: { admitted: number; truncated: boolean; spent?: number; budgetChars?: number };
      };
      expect(admission.admitted).toBe(0);
      expect(admission.truncated).toBe(true);
      expect(admission.budgetChars).toBe(50);
      expect(admission.spent).toBe(0);
    });

    it('records EVERY stage even at zero — a filter that ran and removed nothing is not a filter that never ran', async () => {
      useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
      });
      await flush();
      const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
        admission: { dropped: Record<string, number>; admitted: number };
      };
      expect(Object.keys(admission.dropped).sort()).toEqual([
        'budget',
        'dedup',
        'feedback',
        'jev',
        'nearDuplicate',
        'pack',
        'workspace',
      ]);
      expect(admission.admitted).toBe(1);
    });

    it('attributes ADMITTED lines to the leg that produced them', async () => {
      // Provenance rides on the entry (stamped by fuse()); the funnel counts it
      // over the DELIVERED set, which is the only set that says a leg is earning
      // its place rather than merely offering candidates.
      useBackend(
        mockBackend([
          { id: 'm1', text: 'alpha', retrieval: { cosineRank: 1 } },
          { id: 'm2', text: 'bravo', retrieval: { cosineRank: 2, lexicalRank: 1 } },
          { id: 'm3', text: 'charlie', retrieval: { lexicalRank: 2 } },
        ] as never),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
      });
      await flush();
      const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
        admission: { byLeg: Record<string, number> };
      };
      expect(admission.byLeg).toEqual({ cosineOnly: 1, lexicalOnly: 1, both: 1 });
    });

    it('still writes a row when the block is EMPTY — the zero-hit rate is the signal', async () => {
      // The write moved into a `finally` precisely so the several early-return
      // paths keep recording. A recall that delivers nothing is the single most
      // important row in this table; dropping it would make the index look
      // healthiest exactly when it is worst.
      useBackend(mockBackend([]));
      const block = await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
      });
      await flush();
      expect(block).toBeNull();
      expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
      expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
        admission: { returned: 0, admitted: 0 },
      });
    });

    it('still writes exactly one zero-hit row when the search itself fails', async () => {
      const backend = mockBackend([]);
      backend.search.mockRejectedValue(new Error('search transport failed'));
      useBackend(backend);

      const block = await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why did the recall fail',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
      });
      await flush();

      expect(block).toBeNull();
      expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
      expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
        pools: { user: { entries: [] }, harness: { entries: [] } },
        admission: { returned: 0, admitted: 0 },
      });
    });

    it('records only safe timeout facts when the search times out', async () => {
      const backend = mockBackend([]);
      backend.search.mockRejectedValue(new MemoryTimeoutError(
        'raw request query and session su-private must not be copied',
        'request-budget',
        'shared-budget',
        5000,
      ));
      useBackend(backend);

      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'raw request query',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
      });
      await flush();

      const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
        admission: { timeout: Record<string, unknown> };
      };
      expect(admission.timeout).toEqual({
        scope: 'request-budget', phase: 'shared-budget', elapsedMs: 5000,
      });
      expect(Object.keys(admission.timeout).sort()).toEqual(['elapsedMs', 'phase', 'scope']);
      expect(JSON.stringify(admission.timeout)).not.toContain('raw request query');
      expect(JSON.stringify(admission.timeout)).not.toContain('su-private');
    });

    it('records safe timeout facts when backend availability times out before search', async () => {
      const backend = mockBackend([]);
      backend.available.mockRejectedValue(new MemoryTimeoutError(
        'raw request query and session su-private must not be copied',
        'backend-operation',
        'availability',
        5000,
      ));
      try {
        useBackend(backend);

        await buildMemoryContextBlock({
          userId: 'u1',
          workspaceId: 'ws',
          queryContext: 'raw request query',
          harnessSlugs: ['papercusp'],
          potSlugs: [],
        });
        await flush();

        const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
          admission: { timeout: Record<string, unknown> };
        };
        expect(admission.timeout).toEqual({
          scope: 'backend-operation', phase: 'availability', elapsedMs: 5000,
        });
        expect(Object.keys(admission.timeout).sort()).toEqual(['elapsedMs', 'phase', 'scope']);
      } finally {
        resetMemoryDegradedForTest();
      }
    });

    it('writes EXACTLY ONE row per recall', async () => {
      useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
      });
      await flush();
      expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
    });

    it('keeps hit_count/pools meaning WHAT THE INDEX RETURNED, not what survived', async () => {
      // Recurrence guard for the trap the deferred write created: the three pool
      // variables are REASSIGNED by the filters, so reading them live at write
      // time would silently redefine three existing columns — changing every
      // historical comparison without touching a query. Budget-drop two of three
      // and assert the pools still report all three.
      useBackend(
        mockBackend([
          { id: 'm1', text: 'alpha alpha alpha alpha alpha alpha alpha alpha' },
          { id: 'm2', text: 'bravo bravo bravo bravo bravo bravo bravo bravo' },
          { id: 'm3', text: 'charlie charlie charlie charlie charlie charlie' },
        ]),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        potSlugs: [],
        budgetChars: 60,
      });
      await flush();
      const input = recordRecallStatsMock.mock.calls[0]![1] as {
        pools: Record<string, { entries: unknown[] }>;
        admission: { admitted: number; returned: number };
      };
      // Sum over whatever pools were actually recorded — EI-19920080383279759
      // omits a pool key entirely when it was never queried (e.g. `hive` here,
      // since potSlugs: [] suppresses it), so this must not assume all three
      // keys are present.
      const pooled = Object.values(input.pools).reduce((sum, p) => sum + p.entries.length, 0);
      // `pools` is the PRE-filter view and must agree with the funnel's
      // `returned`, never with `admitted`.
      expect(pooled).toBe(input.admission.returned);
      expect(input.admission.admitted).toBeLessThan(pooled);
    });
  });
});

/**
 * context-injection-audit-2026-07-28 P-042 (F-J) — the structured query seam,
 * asserted END-TO-END through buildMemoryContextBlock.
 *
 * recall-query.test.ts pins the helpers in isolation; this pins that injection.ts
 * actually ROUTES both forms through them. That distinction matters here: the
 * three readers of `queryContext` (the emptiness gate, the backend search, and
 * the P-041 telemetry) were separate `input.queryContext` reads before P-042, and
 * the failure mode of a partial migration is that ONE of them keeps reading the
 * raw union — which typechecks against `string | RecallQuery` in some positions
 * and silently stringifies an object into "[object Object]" in others.
 */
describe('the injection seam accepts a structured recall query (P-042 / F-J)', () => {
  // Let the FIRE-AND-FORGET telemetry write land. It is `void`-ed on purpose, so
  // there is nothing to await — the test has to yield until it completes.
  //
  // ⚠ MACROTASK turns, not `Promise.resolve()` microtasks. The writer does
  // `await import('./recall-stats')`, and a dynamic import does not settle by
  // spinning the microtask queue however many times you spin it. The old
  // 5-microtask version passed only because the write was START­ED early in
  // buildMemoryContextBlock and had the whole filter chain's awaits to resolve
  // in — i.e. it was coupled to WHERE the call sat in the function, not to the
  // work it does. P-002 moved that write into a `finally` (so every exit path
  // records exactly one row) and the coupling surfaced as 7 failures that look
  // like assertion breaks and are really a hidden timing dependency.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('issues the SAME index query for a string and its structured equivalent', async () => {
    const asString = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(asString);
    await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'why is the recall empty',
    });

    const asObject = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(asObject);
    await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: { userText: 'why is the recall empty' },
    });

    expect(asObject.search.mock.calls[0]![0]).toBe('why is the recall empty');
    expect(asObject.search.mock.calls[0]![0]).toBe(asString.search.mock.calls[0]![0]);
  });

  // The "[object Object]" detector. Without it, a missed normalization at the
  // search call still passes every existing test — they all assert on OPTIONS and
  // on returned rows, and this file's fake backend ignores the query entirely.
  it('never stringifies the object form into the query', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: { userText: 'deploy pipeline' },
    });
    expect(backend.search.mock.calls[0]![0]).not.toContain('[object Object]');
  });

  /**
   * ⚠ TRIPWIRE — the same one recall-query.test.ts carries, at the level that
   * actually matters (what the backend is asked). P-044 is what makes signals
   * reach retrieval; until then this failing means the baseline is at risk.
   */
  it('carries agent signals WITHOUT letting them reach the index (P-043/P-044 do that)', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: {
        userText: 'continue',
        agentSignals: {
          workItem: { id: 'WI-6635', title: 'Instrument the QUERY', body: 'record query shape' },
          trajectory: { paths: ['lib/memory/recall-stats.ts'], symbols: ['describeRecallQuery'] },
          activeFile: 'lib/memory/injection.ts',
        },
      },
    });
    expect(backend.search.mock.calls[0]![0]).toBe('continue');
  });

  it('records the EFFECTIVE retrieval text in the P-041 query telemetry', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      harnessSlugs: ['papercusp'],
      queryContext: {
        userText: 'why is the recall empty',
        agentSignals: { workItem: { id: 'WI-6635' } },
      },
    });
    await flush();
    // Not the object, not "[object Object]", and — until P-044 — not the signals.
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
      query: 'why is the recall empty',
    });
  });

  it('returns null for an empty structured query, exactly as for an empty string', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    for (const queryContext of ['', '   ', { userText: '' }, { userText: '   ' }]) {
      expect(
        await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext }),
      ).toBeNull();
    }
    // The gate short-circuits before the backend is ever consulted.
    expect(backend.search).not.toHaveBeenCalled();
  });
});

describe('lastUserContext', () => {
  it('returns empty string for no user messages', () => {
    expect(lastUserContext([])).toBe('');
    expect(lastUserContext([{ role: 'assistant', content: 'hi' }])).toBe('');
  });

  it('joins last N user-turn contents', () => {
    const out = lastUserContext([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'user', content: 'four' },
    ], 3);
    expect(out).toBe('two\nthree\nfour');
  });
});

describe('buildMemoryContextBlock', () => {
  it.each(['', 'repair delivery'])('preserves an exact lexical-only query when the semantic backend is unavailable: %s', async userText => {
    const backend = { ...mockBackend([], { ok: false, reason: 'embedder unavailable' }),
      searchLexical: vi.fn(async (query: string) => [
        { id: 'exact-id', text: query + ' delivery recovery', score: 0.9, scope: 'user:u1' },
        { id: 'below-floor', text: 'unrelated lexical entry', score: 0.01, scope: 'user:u1' },
      ]),
    };
    useBackend(backend);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', potSlugs: [],
      queryContext: { userText, lexicalText: 'WI-6512', fingerprint: 'normalized-signal' },
    });
    expect(backend.available).toHaveBeenCalledTimes(userText ? 1 : 0);
    expect(backend.search).not.toHaveBeenCalled();
    expect(backend.searchLexical).toHaveBeenCalledWith('WI-6512', expect.objectContaining({ scope: expect.any(Array) }));
    expect(block).toContain('WI-6512');
    expect(block).not.toContain('unrelated lexical entry');
  });

  it('returns null when query context is empty', async () => {
    useBackend(mockBackend([]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: '' });
    expect(block).toBeNull();
  });

  it('returns null when the backend is unavailable', async () => {
    useBackend(mockBackend([], { ok: false, reason: 'mem0_unavailable' }));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
      pools: { user: { entries: [] } },
      admission: { returned: 0, admitted: 0 },
    });
  });

  it('surfaces an early-zero telemetry scheduling fault only in P-006 strict mode', async () => {
    const originalStrict = process.env.PAPERCUSP_P006_RECALL_STATS_STRICT;
    const telemetryFailure = new Error('synthetic early telemetry failure');
    process.env.PAPERCUSP_P006_RECALL_STATS_STRICT = 'on';
    recordRecallStatsMock.mockImplementationOnce(() => {
      throw telemetryFailure;
    });
    useBackend(mockBackend([]));
    noteMemoryFailure(new MemoryTimeoutError('prior recall timed out'));
    try {
      const build = buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'strict early' });
      await expect(build).rejects.toMatchObject({
        message: expect.stringContaining('"phase":"early-zero"'),
        cause: telemetryFailure,
      });
    } finally {
      resetMemoryDegradedForTest();
      if (originalStrict === undefined) delete process.env.PAPERCUSP_P006_RECALL_STATS_STRICT;
      else process.env.PAPERCUSP_P006_RECALL_STATS_STRICT = originalStrict;
    }
  });

  it('surfaces a normal telemetry scheduling fault only in P-006 strict mode', async () => {
    const originalStrict = process.env.PAPERCUSP_P006_RECALL_STATS_STRICT;
    const telemetryFailure = new Error('synthetic snapshot telemetry failure');
    process.env.PAPERCUSP_P006_RECALL_STATS_STRICT = 'on';
    recordRecallStatsMock.mockImplementationOnce(() => {
      throw telemetryFailure;
    });
    useBackend(mockBackend([]));
    try {
      const build = buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'strict snapshot' });
      await expect(build).rejects.toMatchObject({
        message: expect.stringContaining('"phase":"snapshot"'),
        cause: telemetryFailure,
      });
    } finally {
      if (originalStrict === undefined) delete process.env.PAPERCUSP_P006_RECALL_STATS_STRICT;
      else process.env.PAPERCUSP_P006_RECALL_STATS_STRICT = originalStrict;
    }
  });

  it('returns null when the availability probe throws', async () => {
    const b = mockBackend([]);
    b.available = vi.fn(async () => { throw new Error('boom'); });
    useBackend(b);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
      admission: { returned: 0, admitted: 0 },
    });
  });

  it('returns null when search throws', async () => {
    const b = mockBackend([]);
    b.search = vi.fn(async () => { throw new Error('pg down'); });
    useBackend(b);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
  });

  it('schedules one zero-hit row before every degraded-latch build resolves', async () => {
    const backend = mockBackend([]);
    useBackend(backend);
    noteMemoryFailure(new MemoryTimeoutError('prior recall timed out'));
    try {
      for (let index = 0; index < 6; index += 1) {
        const block = await buildMemoryContextBlock({
          userId: 'u1',
          workspaceId: 'ws',
          queryContext: `degraded recall ${index}`,
        });
        expect(block).toBeNull();
        expect(recordRecallStatsMock).toHaveBeenCalledTimes(index + 1);
      }
      expect(backend.available).not.toHaveBeenCalled();
      expect(backend.search).not.toHaveBeenCalled();
    } finally {
      resetMemoryDegradedForTest();
    }
  });

  it('schedules exactly one telemetry call for each concurrent completed recall', async () => {
    useBackend(mockBackend([]));
    const blocks = await Promise.all(
      Array.from({ length: 8 }, (_, index) => buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: `concurrent recall ${index}`,
      })),
    );
    expect(blocks).toEqual(Array(8).fill(null));
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(8);
    expect(recordRecallStatsMock.mock.calls.map(([, input]) => (input as { query: string }).query).sort())
      .toEqual(Array.from({ length: 8 }, (_, index) => `concurrent recall ${index}`));
  });

  it('returns null when no hits', async () => {
    useBackend(mockBackend([]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('formats user hits with their kind', async () => {
    useBackend(mockBackend([
      { id: 'i1', text: 'User prefers terse replies', kind: 'preference' },
      { id: 'i2', text: 'User name is Aviyn', kind: 'identity' },
    ]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'who am i' });
    expect(block).toContain('## Operator memory (relevant entries)');
    expect(block).toContain('- [preference] (id=i1) source-evidence "User prefers terse replies"');
    expect(block).toContain('- [identity] (id=i2) source-evidence "User name is Aviyn"');
  });

  it('redacts credential-bearing memory text before returning the recall block', async () => {
    useBackend(mockBackend([
      {
        id: 'i-secret',
        text: 'Database recovery note: postgresql://memory-user:synthetic-db-password@db.example/app',
        kind: 'project',
      },
    ]));
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'database recovery',
    });
    expect(block).toContain('postgresql://[redacted]@db.example/app');
    expect(block).not.toContain('synthetic-db-password');
  });

  it('labels a harness-scoped hit with its slug', async () => {
    useBackend(mockBackend([
      { id: 'i3', text: 'Project uses PG by default', kind: 'project' },
    ]));
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['papercup'], queryContext: 'storage?',
    });
    expect(block).toContain('- [project @ papercup] (id=i3) source-evidence "Project uses PG by default"');
  });

  it('falls back to unknown kind when the entry has none', async () => {
    useBackend(mockBackend([{ id: 'i4', text: 'Bare fact' }]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toContain('- [unknown] (id=i4) source-evidence "Bare fact"');
  });

  it('respects custom heading', async () => {
    useBackend(mockBackend([{ id: 'i5', text: 'X', kind: 'project' }]));
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'x', heading: 'Brainstorm memory',
    });
    expect(block).toMatch(/^## Brainstorm memory/);
  });

  it('pulls user + harness scopes only — no deprecated workspace pull (D-005)', async () => {
    const b = mockBackend([{ id: 'i6', text: 'x', kind: 'preference' }]);
    useBackend(b);
    await buildMemoryContextBlock({
      userId: 'u-123', workspaceId: 'ws-7', harnessSlugs: ['papercup'], queryContext: 'foo',
    });
    // ONE search over the UNION of the pools (F-C / P-033, D-011) — never a
    // `workspace:*` scope. It carries the inject relevance floor
    // (injectMinScore()) + the hybrid push lexical bar (injectMinLexScore())
    // — the no-LLM-in-the-loop precision gate (P-031 / D-003) — and
    // fusionMode 'cosine-gated', which makes the limit a CEILING rather than a
    // target (P-032 / F-B, D-010). `limit` is now the TOTAL across all pools,
    // replacing the old per-pool quotas (user 6 + harness 3 + hive 3 = 12).
    // …and `diversify` (P-034 / F-D, D-014): the redundancy penalty this chain
    // otherwise has nowhere — every other pass ranks on relevance alone.
    expect(b.search.mock.calls).toEqual([
      [
        'foo',
        {
          signal: expect.any(AbortSignal),
          scope: ['u-123', 'harness:papercup'],
          limit: 12,
          minScore: MEMORY_INJECTION_COSINE_FLOOR,
          minLexScore: MEMORY_INJECTION_LEX_FLOOR,
          fusionMode: 'cosine-gated',
          diversify: { lambda: 0.7 },
          // P-002: the leg-provenance reporting seam. Asserted as a FUNCTION
          // rather than dropped from the shape — this stays an exact-shape
          // assertion, so an option added here in future still has to be
          // declared deliberately instead of slipping in unnoticed.
          onLegStats: expect.any(Function),
        },
      ],
    ]);
  });

  it('filters ephemeral/benchmark harness slugs from the fan-out (P-016)', async () => {
    const b = mockBackend([{ id: 'i7', text: 'real fact', kind: 'reference' }]);
    useBackend(b);
    // Mix of production and ephemeral slugs; only papercup should survive.
    await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws',
      harnessSlugs: ['papercup', 'hiveloop-hive', 'xbq72ugvazs', 'bench-memcap-probe-DELETEME'],
      queryContext: 'storage?',
    });
    const scopes = b.search.mock.calls.map((c: unknown[]) => (c[1] as { scope: unknown }).scope);
    expect(scopes).toEqual([['harness:papercup']]);
  });

  it('context reliability R-2: same-source-revision', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const text = 'zephyrrepair requires approval before execution';
    useBackend(mockBackend([{ id, text }]));
    const input = { userId: 'u1', workspaceId: 'ws', harnessSlugs: [], potSlugs: [],
      queryContext: 'zephyrrepair approval', budgetChars: 1800 };
    const prepare = (port: string, epoch = 3) => prepareMemoryContextBlock({ ...input,
      session: { sessionId: 'su-same-source-revision', epoch, port } });
    const initial = await prepare('turn-start');
    expect(initial?.text).toContain(text);
    expect(initial?.fragments).toHaveLength(1);
    const fragment = initial!.fragments[0]!;
    // A stable id without the exact source fingerprint cannot suppress recall.
    sqlMockState.rows = [{ id }];
    expect((await prepare('orient'))?.fragments[0]?.sourceFingerprint).toBe(fragment.sourceFingerprint);
    sqlMockState.rows = [{ id, epoch: 3, source_fingerprint: fragment.sourceFingerprint,
      source_version: fragment.sourceVersion }];
    for (const port of ['orient', 'mid-turn', 'initialize']) expect(await prepare(port)).toBeNull();
    // Identical text at a later canonical revision must remain eligible.
    useBackend(mockBackend([{ id, text, metadata: { revision: 'r2' } }]));
    const later = await prepare('mid-turn');
    expect(later?.fragments).toHaveLength(1);
    expect(later!.fragments[0]!.sourceFingerprint).not.toBe(fragment.sourceFingerprint);
    expect(later?.text).toContain('replace-earlier-version');
  });

  it('delivers a same-epoch correction under the same memory id and suppresses only its confirmed canonical version', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const input = { userId: 'u1', workspaceId: 'ws', harnessSlugs: [], potSlugs: [],
      queryContext: 'zephyrrepair approval', budgetChars: 1800,
      session: { sessionId: 'su-source-correction', epoch: 3, port: 'turn-start' } };
    useBackend(mockBackend([{ id, text: 'zephyrrepair requires approval before execution' }]));
    const first = await prepareMemoryContextBlock(input);
    const firstFragment = first!.fragments.find(row => row.kind === 'memory')!;
    expect(firstFragment.sourceVersion?.fullTextSha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    sqlMockState.rows = [{ id, source_fingerprint: firstFragment.sourceFingerprint, source_version: firstFragment.sourceVersion }];
    const unchanged = await prepareMemoryContextBlock(input);
    expect(unchanged?.fragments ?? []).toEqual([]);
    useBackend(mockBackend([{ id, text: 'zephyrrepair requires independent approval before execution' }]));
    const corrected = await prepareMemoryContextBlock(input);
    const correctedFragment = corrected!.fragments.find(row => row.kind === 'memory')!;
    expect(corrected?.text).toContain('independent approval');
    expect(corrected?.text).toContain('source-change');
    expect(corrected?.text).toContain('replace-earlier-version');
    expect(correctedFragment.sourceFingerprint).not.toBe(firstFragment.sourceFingerprint);
    sqlMockState.rows = [{ id, source_fingerprint: correctedFragment.sourceFingerprint }];
    expect((await prepareMemoryContextBlock(input))?.fragments ?? []).toEqual([]);
  });

  it('rechecks a prepared memory through its scoped canonical reader for each receipt attempt', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const original = 'zephyrrepair requires approval before execution';
    let current: string | null = original;
    const backend = Object.assign(mockBackend([{ id, text: original }]), {
      get: vi.fn(async () => { throw new Error('unscoped read forbidden'); }),
      listPage: vi.fn(async (_options: unknown) => ({ total: current === null ? 0 : 1,
        entries: current === null ? [] : [{ id, scope: 'u1', text: current }] })),
    });
    useBackend(backend);
    const prepared = await prepareMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', harnessSlugs: [], potSlugs: [],
      queryContext: 'zephyrrepair approval', budgetChars: 1800,
      session: { sessionId: 'su-source-freshness', epoch: 3, port: 'turn-start' } });
    const fragment = prepared!.fragments.find(row => row.kind === 'memory')!;
    expect((await fragment.revalidateSource!(new AbortController().signal))?.fingerprint).toBe(fragment.sourceFingerprint);
    current = 'zephyrrepair requires independent approval before execution';
    expect((await fragment.revalidateSource!(new AbortController().signal))?.fingerprint).not.toBe(fragment.sourceFingerprint);
    current = null;
    expect(await fragment.revalidateSource!(new AbortController().signal)).toBeNull();
    expect(backend.listPage).toHaveBeenCalledTimes(3);
    expect(backend.listPage).toHaveBeenCalledWith({ scope: 'u1', ids: [id], includeSuperseded: true, offset: 0, limit: 8 });
    expect(backend.get).not.toHaveBeenCalled();
  });

  it.each(['current', 'superseded', 'retracted', 'expired'] as const)(
    'revalidates a confirmed memory absent from search with current scoped %s evidence', async status => {
      const id = '11111111-1111-4111-8111-111111111111';
      const before = contextSourceVersion({ namespace: 'memory:u1', ref: id, fullText: 'Earlier private guidance',
        revision: 'r1', updatedAt: null,
        validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
      const backend = Object.assign(mockBackend([]), {
        get: vi.fn(async () => { throw new Error('unscoped read forbidden'); }),
        listPage: vi.fn(async () => ({ total: 1, entries: [{ id, scope: 'u1', text: 'Changed private guidance',
          metadata: { revision: 'r2', validity: { status, superseded_by: 'hidden-foreign-replacement' } } }] })),
      });
      const due = vi.spyOn(memoryLedger, 'memorySourcesDueForRevalidation').mockResolvedValue([before]);
      useBackend(backend);
      try {
        const result = await prepareMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', harnessSlugs: [], potSlugs: [],
          queryContext: 'an unrelated task', budgetChars: 1400,
          session: { sessionId: 'su-memory-lifecycle', epoch: 2, port: 'mid-turn' } });
        expect(result?.text).toContain(status === 'current' ? 'replace-earlier-version' : 'withdraw-earlier-version');
        expect(result?.text?.match(/source-change /g)).toHaveLength(1);
        expect(result?.text).not.toContain('private guidance');
        expect(result?.text).not.toContain('hidden-foreign-replacement');
        expect(result?.fragments).toMatchObject([{ kind: 'memory', id, epoch: 2,
          sourceVersion: { validity: { status, supersededBy: null } } }]);
        expect(backend.listPage).toHaveBeenCalledWith({ scope: 'u1', ids: [id],
          includeSuperseded: true, limit: 8, offset: 0 });
        expect(backend.get).not.toHaveBeenCalled();
        expect(sqlMockState.statements.some(statement => /INSERT INTO harness_shared.memory_session_surfaced/.test(statement))).toBe(false);
      } finally { due.mockRestore(); }
    });

  it('rechecks ordinary hive pack visibility once per receipt attempt and detects disable/re-enable', async () => {
    const rows = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
      .map((id, index) => ({ id, text: index === 0 ? 'zephyrrepair preserves a rollback snapshot'
        : 'zephyrrepair validates independent approval', scope: 'hive:my-hive',
        metadata: { source: 'pack', pack_id: 'repair-pack', validity: { status: 'current' } } }));
    const backend = Object.assign(mockBackend(rows), {
      listPage: vi.fn(async () => ({ total: rows.length, entries: rows })),
    });
    let disabled: string[] = [];
    const visibility = vi.spyOn(hiveSettings, 'getHiveSetting').mockImplementation(async () => ({
      workspaceId: 'ws', potHomeSlug: 'my-hive', settingKey: 'knowledge-packs:disabled',
      value: disabled, createdAt: 0, updatedAt: 1_700_000_000_000,
    }));
    const renderVisibility = vi.spyOn(packManagement, 'disabledPacksFor').mockImplementation(async () => disabled);
    useBackend(backend);
    try {
      const prepared = await prepareMemoryContextBlock({ userId: null, workspaceId: 'ws', harnessSlugs: [],
        potSlugs: ['my-hive'], queryContext: 'zephyrrepair guidance', budgetChars: 1800,
        session: { sessionId: 'su-pack-source-freshness', epoch: 3, port: 'turn-start' } });
      const fragments = prepared!.fragments.filter(row => row.kind === 'memory');
      expect(fragments).toHaveLength(2);
      const firstAttempt = new AbortController().signal;
      expect(await Promise.all(fragments.map(row => row.revalidateSource!(firstAttempt))))
        .toEqual(fragments.map(row => row.sourceVersion));
      expect(visibility).toHaveBeenCalledTimes(1);
      disabled = ['repair-pack'];
      const secondAttempt = new AbortController().signal;
      const withdrawn = await Promise.all(fragments.map(row => row.revalidateSource!(secondAttempt)));
      expect(withdrawn).toMatchObject(fragments.map(() => ({ validity: {
        status: 'retracted', invalidAt: '2023-11-14T22:13:20.000Z', supersededBy: null,
      } })));
      expect(visibility).toHaveBeenCalledTimes(2);
      expect(visibility.mock.calls.every(call => call[0] === 'ws' && call[1] === 'my-hive' &&
        call[2] === 'knowledge-packs:disabled' && typeof call[3] === 'function')).toBe(true);
      await expect(stageMemoryEmission(getOrgPg().sql, 'su-pack-source-freshness', 'disabled-pack-attempt', fragments))
        .rejects.toThrow('Memory emission source changed or is unavailable');
      expect(visibility).toHaveBeenCalledTimes(3);
      disabled = [];
      expect((await fragments[0].revalidateSource!(new AbortController().signal))?.fingerprint)
        .toBe(fragments[0].sourceFingerprint);
      expect(visibility).toHaveBeenCalledTimes(4);
    } finally { visibility.mockRestore(); renderVisibility.mockRestore(); }
  });

  it.each(['disabled', 'enabled', 'read-error', 'malformed', 'identity-package', 'foreign-pool'])(
    'revalidates a previously confirmed hive pack with strict %s authority', async scenario => {
      const id = '11111111-1111-4111-8111-111111111111';
      const before = contextSourceVersion({ namespace: 'memory:hive:my-hive', ref: id, fullText: 'Earlier pack guidance',
        revision: null, updatedAt: null,
        validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
      const backend = Object.assign(mockBackend([]), {
        get: vi.fn(async () => { throw new Error('unscoped read forbidden'); }),
        listPage: vi.fn(async () => ({ total: 1, entries: [{ id, text: 'Changed pack guidance',
          scope: scenario === 'foreign-pool' ? 'hive:foreign' : 'hive:my-hive', metadata: {
            source: 'pack', pack_id: 'repair-pack', validity: { status: 'current' },
            ...(scenario === 'identity-package' ? { identity_package_resource: 'private-resource' } : {}),
          } }] })),
      });
      const visibility = vi.spyOn(hiveSettings, 'getHiveSetting').mockImplementation(async () => {
        if (scenario === 'read-error') throw new Error('setting read unavailable');
        return { workspaceId: 'ws', potHomeSlug: 'my-hive', settingKey: 'knowledge-packs:disabled',
          value: scenario === 'malformed' ? 'not a list' : scenario === 'disabled' ? ['repair-pack'] : [],
          createdAt: 0, updatedAt: 1_700_000_000_000 };
      });
      const due = vi.spyOn(memoryLedger, 'memorySourcesDueForRevalidation').mockResolvedValue([before]);
      useBackend(backend);
      try {
        const prepared = await prepareMemoryContextBlock({ userId: null, workspaceId: 'ws', harnessSlugs: [],
          potSlugs: ['my-hive'], queryContext: 'unrelated task', budgetChars: 1400,
          session: { sessionId: 'su-pack-lifecycle', epoch: 2, port: 'mid-turn' } });
        if (scenario === 'disabled' || scenario === 'enabled') {
          expect(prepared?.text).toContain(scenario === 'disabled' ? 'withdraw-earlier-version' : 'replace-earlier-version');
          expect(prepared?.text).not.toContain('pack guidance');
          expect(prepared?.fragments).toMatchObject([{ kind: 'memory', id,
            sourceVersion: { validity: { status: scenario === 'disabled' ? 'retracted' : 'current' } } }]);
        } else {
          expect(prepared?.text ?? '').not.toContain('source-change');
          expect(prepared?.fragments ?? []).toEqual([]);
        }
        expect(backend.get).not.toHaveBeenCalled();
        if (scenario === 'identity-package' || scenario === 'foreign-pool') expect(visibility).not.toHaveBeenCalled();
      } finally { visibility.mockRestore(); due.mockRestore(); }
    });

  it.each(['missing', 'foreign-pool', 'foreign-workspace', 'wrong-id', 'pack', 'read-error', 'no-current-pool', 'budget'])(
    'keeps memory lifecycle unknown or withheld for %s without an unscoped fallback', async scenario => {
      const id = '11111111-1111-4111-8111-111111111111';
      const before = contextSourceVersion({ namespace: 'memory:u1', ref: id, fullText: 'Earlier private guidance',
        revision: 'r1', updatedAt: null,
        validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
      const backend = Object.assign(mockBackend([]), {
        get: vi.fn(async () => { throw new Error('unscoped read forbidden'); }),
        listPage: vi.fn(async () => {
          if (scenario === 'read-error') throw new Error('unavailable');
          return { total: 1, entries: scenario === 'missing' ? [] : [{
            id: scenario === 'wrong-id' ? '22222222-2222-4222-8222-222222222222' : id,
            scope: scenario === 'foreign-pool' ? 'foreign' : 'u1', text: 'Changed private guidance', kind: 'project',
            metadata: { workspace_id: scenario === 'foreign-workspace' ? 'foreign' : 'ws',
              ...(scenario === 'pack' ? { source: 'pack' } : {}), revision: 'r2' },
          }] };
        }),
      });
      const due = vi.spyOn(memoryLedger, 'memorySourcesDueForRevalidation').mockResolvedValue([before]);
      useBackend(backend);
      try {
        const result = await prepareMemoryContextBlock({ userId: scenario === 'no-current-pool' ? null : 'u1',
          workspaceId: 'ws', harnessSlugs: [], potSlugs: [], queryContext: 'an unrelated task',
          budgetChars: scenario === 'budget' ? 20 : 1400,
          session: { sessionId: 'su-memory-lifecycle', epoch: 2, port: 'mid-turn' } });
        expect(result?.text ?? '').not.toContain('source-change');
        expect(result?.text ?? '').not.toContain('private guidance');
        expect(result?.fragments ?? []).toEqual([]);
        expect(backend.get).not.toHaveBeenCalled();
        if (scenario === 'no-current-pool') expect(backend.listPage).not.toHaveBeenCalled();
      } finally { due.mockRestore(); }
    });

  it('dedups a memory surfaced within the watermark window (D-006)', async () => {
    const stale = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const fresh = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    useBackend(mockBackend([
      { id: stale, text: 'stale fact', kind: 'preference' },
      { id: fresh, text: 'fresh fact', kind: 'preference' },
    ]));
    // `stale` was surfaced recently → the guard must drop it; `fresh` stays.
    sqlMockState.rows = [{ id: stale }];
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
    expect(block).toContain('fresh fact');
    expect(block).not.toContain('stale fact');
  });

  it('returns null when every hit was recently surfaced', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    useBackend(mockBackend([
      { id, text: 'only fact', kind: 'preference' },
    ]));
    sqlMockState.rows = [{ id }];
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
    expect(block).toBeNull();
  });

  it('pulls + labels the hive pool for a member harness (knowledge-packs P-004)', async () => {
    registryProjects = [
      { slug: 'member-a', hive_slug: 'my-hive' },
      { slug: 'my-hive', harness_kind: 'hive' },
    ];
    // The harness pool and hive pool are DISTINCT stores with distinct content — return
    // per-scope facts (the flat mockBackend returns identical rows for every scope, which the
    // P-008 near-duplicate collapse would correctly fold, hiding the hive label under test).
    const b = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async (_q: string, opts: { scope: string | readonly string[] }) => {
        const scopes = typeof opts.scope === 'string' ? [opts.scope] : [...opts.scope];
        return scopes.map((scope) =>
          scope.startsWith('hive:')
            ? { id: 'h1', text: 'Hive convention: tests ship with the feature', kind: 'feedback', scope }
            : { id: 'a1', text: 'Harness note: run npm test before pushing', kind: 'feedback', scope },
        );
      }),
    };
    useBackend(b as unknown as ReturnType<typeof mockBackend>);
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['member-a'], queryContext: 'testing?',
    });
    // ONE pull over both pools — the hive scope is resolved from the registry
    // and joins the same multi-scope search (F-C / D-011).
    expect(b.search.mock.calls).toEqual([
      [
        'testing?',
        {
          signal: expect.any(AbortSignal),
          scope: ['harness:member-a', 'hive:my-hive'],
          limit: 12,
          minScore: MEMORY_INJECTION_COSINE_FLOOR,
          minLexScore: MEMORY_INJECTION_LEX_FLOOR,
          fusionMode: 'cosine-gated',
          diversify: { lambda: 0.7 },
          // P-002: the leg-provenance reporting seam. Asserted as a FUNCTION
          // rather than dropped from the shape — this stays an exact-shape
          // assertion, so an option added here in future still has to be
          // declared deliberately instead of slipping in unnoticed.
          onLegStats: expect.any(Function),
        },
      ],
    ]);
    expect(block).toContain('- [feedback @ hive:my-hive] (id=h1) source-evidence "Hive convention: tests ship with the feature"');
    expect(block).toContain('- [feedback @ member-a] (id=a1) source-evidence "Harness note: run npm test before pushing"');
  });

  it('P-008: collapses near-duplicate memories (same fact under different ids) before the budget', async () => {
    const dupText = 'owner directive: put yourself on auto mode and continue the full plan';
    useBackend(mockBackend([
      { id: 'd1', text: dupText, kind: 'preference' },
      { id: 'd2', text: dupText, kind: 'preference' }, // same fact, DIFFERENT id — the WI-4538 case
      { id: 'd3', text: 'a distinct fact about migration 557 renaming hive tables to pots', kind: 'reference' },
    ]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'directives?' });
    expect(block).not.toBeNull();
    // The highest-ranked copy survives; the duplicate id is dropped; the distinct fact is kept
    // (not crowded out — the collapse runs before the budget).
    expect(block).toContain('(id=d1)');
    expect(block).not.toContain('(id=d2)');
    expect(block).toContain('(id=d3)');
  });

  it('budget: hive-pack rows yield first under the cap; truncation is announced; only injected ids get watermarked (P-011)', async () => {
    const prev = process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS;
    process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS = '160';
    try {
      const organic = { id: 'org-1', text: 'this project tests via make test', kind: 'reference' };
      const packed = {
        id: 'pk-1',
        text: 'Tests ship with the feature — a long seeded learning body that will not fit the tiny budget'.repeat(2),
        kind: 'feedback',
        metadata: { source: 'pack', pack_id: 'coding' },
      };
      useBackend(mockBackend([organic, packed]));
      const block = await buildMemoryContextBlock({
        userId: null, workspaceId: 'ws', potSlugs: ['h'], queryContext: 'testing?',
      });
      expect(block).toContain('make test'); // organic admitted first
      expect(block).not.toContain('Tests ship with the feature'); // pack row dropped by the cap
      expect(block).toContain('memory budget is full'); // truncation announced honestly
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS;
      else process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS = prev;
    }
  });

  it('explicit potSlugs: [] suppresses the hive pull; explicit slugs skip resolution', async () => {
    registryProjects = [{ slug: 'member-a', hive_slug: 'my-hive' }];
    const suppressed = mockBackend([{ id: 'x', text: 'x', kind: 'project' }]);
    useBackend(suppressed);
    await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['member-a'], potSlugs: [], queryContext: 'q',
    });
    expect(suppressed.search.mock.calls.map((c) => c[1].scope)).toEqual([['harness:member-a']]);

    const pinned = mockBackend([{ id: 'y', text: 'y', kind: 'feedback' }]);
    useBackend(pinned);
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', potSlugs: ['other-hive'], queryContext: 'q',
    });
    expect(pinned.search.mock.calls.map((c) => c[1].scope)).toEqual([['hive:other-hive']]);
    expect(block).toContain('@ hive:other-hive');
  });

  describe('two-tier markers (self-learning-frontier P-022 / FB-08, D-006)', () => {
    const rows = [
      { id: 'p1', text: 'A probationary lesson', kind: 'project', metadata: { tier: 'probationary' } },
      { id: 'v1', text: 'A validated fact', kind: 'project' },
    ] as never[];
    const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_TRANSFER_HARNESS';

    it('flag dark ⇒ byte-identical output, no markers', async () => {
      // TRANSFER_HARNESS graduated to default-ON (flip-dark-flags-default-on-2026-06-23), so this
      // off-path test pins the flag OFF explicitly rather than relying on the (now-ON) default.
      process.env[FLAG_ENV] = '0';
      try {
        useBackend(mockBackend(rows));
        const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
        expect(block).toContain('- [project] (id=p1) source-evidence "A probationary lesson"');
        expect(block).not.toContain('probationary]');
      } finally {
        delete process.env[FLAG_ENV];
      }
    });

    it('flag armed ⇒ probationary entries are marked, still injected (admission is free)', async () => {
      process.env[FLAG_ENV] = '1';
      try {
        useBackend(mockBackend(rows));
        const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
        expect(block).toContain('- [project · probationary] (id=p1) source-evidence "A probationary lesson"');
        expect(block).toContain('- [project] (id=v1) source-evidence "A validated fact"'); // legacy grandfathered
      } finally {
        delete process.env[FLAG_ENV];
      }
    });
  });

  describe('anchor staleness reaches pre-turn injection (WI-21969321991273109)', () => {
    const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_MEMORY_STALENESS_IN_RECALL';
    const staleAnchor = {
      memory_id: 'm-stale',
      kind: 'file',
      value: 'packages/gone.ts',
      last_checked_at: '2026-08-31T09:00:00Z',
    };

    afterEach(() => {
      delete process.env[FLAG_ENV];
    });

    it('prepends the stored dead-anchor warning while leaving healthy hits unchanged', async () => {
      process.env[FLAG_ENV] = '1';
      sqlMockState.rows = [staleAnchor];
      useBackend(
        mockBackend([
          { id: 'm-stale', text: 'guidance from the removed module', kind: 'project' },
          { id: 'm-healthy', text: 'guidance from the current module', kind: 'project' },
        ]),
      );

      const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'guidance' });

      expect(block).toContain('- [project] (id=m-stale) source-pointer');
      expect(block).not.toContain('guidance from the removed module');
      expect(block).toContain('- [project] (id=m-healthy) source-evidence "guidance from the current module"');
      expect(block).not.toContain('m-healthy) ⚠ STALE');
    });

    it('flag-off preserves the pre-staleness block shape', async () => {
      process.env[FLAG_ENV] = '0';
      sqlMockState.rows = [staleAnchor];
      useBackend(mockBackend([{ id: 'm-stale', text: 'guidance from the removed module', kind: 'project' }]));

      const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'guidance' });

      expect(block).toBe('## Operator memory (relevant entries)\n\n- [project] (id=m-stale) source-evidence "guidance from the removed module"');
      expect(block).not.toContain('STALE');
    });

    it('fails open when the stored-verdict lookup fails', async () => {
      process.env[FLAG_ENV] = '1';
      sqlMockState.failure = new Error('memory anchors unavailable');
      useBackend(mockBackend([{ id: 'm-healthy', text: 'guidance from the current module', kind: 'project' }]));

      const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'guidance' });

      expect(block).toBe('## Operator memory (relevant entries)\n\n- [project] (id=m-healthy) source-evidence "guidance from the current module"');
    });

    it.each(['flag', 'storage'] as const)('retains healthy recall while the advisory %s lookup is pending', async (phase) => {
      process.env[FLAG_ENV] = '1';
      const deadline = createMemoryWorkDeadline(1000);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let started = false;
      const originalGetFlag = flagServer.getFlag;
      const flag = vi.spyOn(flagServer, 'getFlag').mockImplementation(async (...args) => {
        if (args[0] === FLAGS.MEMORY_STALENESS_IN_RECALL && phase === 'flag') {
          started = true;
          await pending;
          return false;
        }
        return originalGetFlag(...args);
      });
      const storage = vi.spyOn(recallStaleness, 'loadMemoryStaleness').mockImplementation(async () => {
        if (phase === 'storage') {
          started = true;
          await pending;
        }
        return new Map();
      });
      const backend = mockBackend([{ id: 'm-healthy', text: 'healthy advisory control', kind: 'project' }]);
      useBackend(backend);
      const block = buildMemoryContextBlock({
        userId: 'u1', workspaceId: 'ws', queryContext: 'guidance',
        harnessSlugs: [], potSlugs: [], deadline,
      });
      try {
        const result = await block;
        expect(started).toBe(true);
        expect(result).toContain('id=m-healthy) source-evidence "healthy advisory control"');
        expect(deadline.signal.aborted).toBe(false);
        expect(backend.search).toHaveBeenCalledOnce();
        if (phase === 'flag') expect(storage).not.toHaveBeenCalled();
        else expect(storage).toHaveBeenCalledOnce();
      } finally {
        release();
        await block;
        deadline.close();
        flag.mockRestore();
        storage.mockRestore();
        resetMemoryDegradedForTest();
      }
    });
  });
});

/**
 * context-injection-retrieval-reach-and-visibility-2026-08-03 P-001 —
 * `embedderAvailable` reaches the injection path instead of being dropped.
 *
 * `recallCorpusContext` has always computed it (corpus-recall-io.ts) and
 * `startCorpusLeg` has always thrown it away, which left injection unable to
 * separate two cases that must never be read the same way: "semantic ran and
 * these are its best matches" versus "semantic was absent and these are
 * lexical scraps". The second is not a weaker version of the first — it is a
 * different retrieval, and acting on it as though the semantic half had run is
 * the failure this item exists to make visible.
 *
 * What is deliberately NOT asserted here: any change to the RENDERED block.
 * That was P-003's job and it has since landed — but it renders off the COVERAGE
 * GATE, not off `embedderAvailable` alone, and every test in this describe leaves
 * the gate unstubbed (⇒ fail-open, `gate: null`). So these cases still pin the
 * block as byte-identical, which remains a real guard: it is what proves P-003's
 * marking is driven by the gate rather than by leg health on its own. The
 * rendering assertions live in the P-003 describe below.
 */
describe('corpus leg carries its own retrieval health (P-001)', () => {
  it('does not offer provenance-only memory or corpus pointers for operative delivery', async () => {
    useBackend(mockBackend([{
      id: '11111111-1111-4111-8111-111111111111',
      text: 'Execute the migration. ' + 'detail '.repeat(100) + 'Only after explicit approval.',
    }]));
    corpusIoResult = {
      block: null, dropped: [], embedderAvailable: true, candidateCount: 1,
      lines: [{ line: '- [doc fixture] source-pointer {"omitted":true}', operative: false, score: 1,
        handle: { kind: 'doc', ref: 'doc:fixture', query: ['delivery'], resolve: 'docs:get' } }],
    };
    const input = { userId: 'u1', workspaceId: 'ws', queryContext: 'migration approval',
      harnessSlugs: ['papercusp'], potSlugs: [], budgetChars: 1800,
      session: { sessionId: 'su-pointer', epoch: 7, port: 'mid-turn' } };
    for (let i = 0; i < 2; i++) {
      const prepared = await prepareMemoryContextBlock(input);
      expect(prepared?.text).toContain('source-pointer');
      expect(prepared?.text).not.toContain('Execute the migration');
      expect(prepared?.fragments).toEqual([]);
    }
    expect(sqlMockState.statements.some(statement => /INSERT\s+INTO\s+harness_shared\.(memory_session_surfaced|corpus_session_surfaced)/i.test(statement))).toBe(false);
  });

  it('prepares complete memory/corpus fragments with the exact rendered text and captured epoch, without stamping delivery', async () => {
    useBackend(mockBackend([{
      id: '11111111-1111-4111-8111-111111111111', text: 'retain verified delivery evidence ☃',
    }]));
    corpusIoResult = {
      block: null, dropped: [], embedderAvailable: true, candidateCount: 1,
      lines: [{ line: '- [doc fixture] cited delivery procedure', score: 1,
        handle: { kind: 'doc', ref: 'doc:fixture', query: ['delivery'], resolve: 'docs:get' } }],
    };
    const prepared = await prepareMemoryContextBlock({ userId: 'u1', workspaceId: 'ws',
      queryContext: 'retain verified delivery evidence', harnessSlugs: ['papercusp'], potSlugs: [], budgetChars: 1800,
      session: { sessionId: 'su-prepared', epoch: 7, port: 'turn-start' } });
    expect(prepared?.fragments.map(row => row.kind).sort()).toEqual(['corpus', 'memory']);
    for (const row of prepared!.fragments) {
      expect(row.epoch).toBe(7);
      expect(row.port).toBe('turn-start');
      expect(row.bodyBytes).toBe(Buffer.byteLength(row.rendered));
      expect(row.bodySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(`\n${prepared!.text}\n`).toContain(`\n${row.rendered}\n`);
    }
    expect(sqlMockState.statements.some(statement => /INSERT\s+INTO\s+harness_shared\.(memory_session_surfaced|corpus_session_surfaced)/i.test(statement))).toBe(false);
  });

  it.each([
    'initialize', 'orient', 'claim', 'create', 'turn-start', 'mid-turn', 'compact-reprime',
    'operator', 'architect', 'oracle', 'agent-chats', 'system-launch', 'system-wake',
  ])('context reliability: %s preparation cannot suppress a lost response', async (port) => {
    useBackend(mockBackend([{
      id: '11111111-1111-4111-8111-111111111111', text: 'retain verified delivery evidence',
    }]));
    corpusIoResult = {
      block: null, dropped: [], embedderAvailable: true, candidateCount: 1,
      lines: [{ line: '- [doc fixture] cited delivery procedure', score: 1,
        handle: { kind: 'doc', ref: 'doc:fixture', query: ['delivery'], resolve: 'docs:get' } }],
    };
    const native = ['initialize', 'orient', 'claim', 'create', 'turn-start', 'mid-turn', 'compact-reprime'].includes(port);
    const input = {
      userId: 'u1', workspaceId: 'ws', queryContext: 'retain verified delivery evidence',
      harnessSlugs: ['papercusp'], potSlugs: [], budgetChars: 1800,
      ...(native ? { session: { sessionId: 'su-lost-response', epoch: 0, port } } : {}),
    };
    // The first prepared response is intentionally never emitted or confirmed.
    const lost = await buildMemoryContextBlock(input);
    const retry = await buildMemoryContextBlock(input);
    for (const block of [lost, retry]) {
      expect(block).toContain('retain verified delivery evidence');
      expect(block).toContain('[doc fixture] cited delivery procedure');
    }
    const suppressionWrites = sqlMockState.statements.filter(statement =>
      /\b(?:INSERT\s+INTO\s+harness_shared\.(?:memory_session_surfaced|corpus_session_surfaced)|UPDATE\s+harness_shared\.memory_canonical)\b/i.test(statement));
    expect(suppressionWrites).toEqual([]);
  });

  it('context reliability: only proven final fragments commit surfaced delivery', async () => {
    configureReadCursorStore(new InMemoryReadCursorStore());
    try {
      const row = {
        id: '11111111-1111-4111-8111-111111111111', text: 'retain verified delivery evidence ☃',
      };
      useBackend(Object.assign(mockBackend([row]), {
        listPage: vi.fn(async () => ({ total: 1, entries: [{ ...row, scope: 'u1' }] })),
      }));
      corpusIoResult = {
        block: null, dropped: [], embedderAvailable: true, candidateCount: 1,
        lines: [{ line: '- [doc fixture] cited delivery procedure', score: 1,
          handle: { kind: 'doc', ref: 'doc:fixture', query: ['delivery'], resolve: 'docs:get' } }],
      };
      const prepared = await prepareMemoryContextBlock({ userId: 'u1', workspaceId: 'ws',
        queryContext: 'retain verified delivery evidence', harnessSlugs: ['papercusp'], potSlugs: [], budgetChars: 1800,
        session: { sessionId: 'su-exact-emission', epoch: 7, port: 'turn-start' } });
      expect(prepared?.fragments.map(row => row.kind).sort()).toEqual(['corpus', 'memory']);
      const memory = prepared!.fragments.find(row => row.kind === 'memory')!;
      const { rendered: _text, ...manifest } = memory;
      const sql = getOrgPg().sql;
      const stamps = () => sqlMockState.statements.filter(statement =>
        /INSERT\s+INTO\s+harness_shared\.(memory_session_surfaced|corpus_session_surfaced)/i.test(statement));
      await stageMemoryEmission(sql, 'su-exact-emission', 'exact-fragments', prepared!.fragments);
      expect(stamps()).toEqual([]); // Prepared, but the response may be lost.
      for (const proof of [
        { token: 'unoffered-token', fragments: [manifest] },
        { token: 'exact-fragments', fragments: [] },
        { token: 'exact-fragments', fragments: [{ ...manifest, bodyBytes: manifest.bodyBytes - 1 }] },
      ]) expect(await confirmMemoryEmission(sql, 'su-exact-emission', proof)).toBe(0);
      expect(stamps()).toEqual([]);
      // The final output contains only memory; the corpus offer was omitted.
      sqlMockState.rows = [{ memory_id: memory.id }];
      const proof = { token: 'exact-fragments', fragments: [manifest] };
      expect(await confirmMemoryEmission(sql, 'su-exact-emission', proof)).toBe(1);
      expect(stamps()).toHaveLength(1);
      expect(stamps()[0]).toContain('memory_session_surfaced');
      expect(stamps().some(statement => statement.includes('corpus_session_surfaced'))).toBe(false);
      expect(await confirmMemoryEmission(sql, 'su-exact-emission', proof)).toBe(0);
      expect(stamps()).toHaveLength(1);
    } finally { resetReadCursorStore(); }
  });

  it('retains eligible mem0 alongside new plan/doc/report contributions without expanding the memory budget', async () => {
    useBackend(mockBackend([{ id: 'm-knowledge-control',text: 'retain verified snapshot' }]));
    corpusIoResult = { block: null,dropped: [],embedderAvailable: true,candidateCount: 3,
      lines: (['plan','doc','report'] as const).map(kind => ({ line: `- [${kind} fixture] cited ${kind} section`,score: 1,
        handle: { kind,ref: `${kind}:fixture`,query: ['repair'],resolve: `${kind}:get` } })),
    };
    const block = await buildMemoryContextBlock({ userId: 'u1',workspaceId: 'ws',harnessSlugs: ['papercusp'],
      queryContext: 'repair the queue boundary',budgetChars: 1800 });
    expect(block).toContain('retain verified snapshot');
    for (const kind of ['plan','doc','report']) expect(block).toContain(`[${kind} fixture] cited ${kind} section`);
    expect(recallCorpusContext).toHaveBeenCalledOnce();
    expect(recallCorpusContext.mock.calls[0]?.[0]).toMatchObject({
      harnessSlugs: ['papercusp'],
      workspaceId: 'ws',
    });
  });

  it('suppresses a previously delivered report at turn start while retaining a new doc and mem0 control', async () => {
    useBackend(mockBackend([{ id: 'm-turn-start-control',text: 'retain verified snapshot' }]));
    const reportVersion = contextSourceVersion({ namespace: 'corpus:report:ws', ref: 'report:fixture',
      fullText: 'cited report section', revision: 'r1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    corpusIoResult = { block: null,dropped: [],embedderAvailable: true,candidateCount: 2,
      lines: (['report','doc'] as const).map(kind => ({ line: `- [${kind} fixture] cited ${kind} section`,score: 1,
        ...(kind === 'report' ? { sourceVersion: reportVersion } : {}),
        handle: { kind,ref: `${kind}:fixture`,query: ['repair'],resolve: `${kind}:get` } })),
    };
    const input = { userId: 'u1',workspaceId: 'ws',harnessSlugs: ['papercusp'],
      queryContext: 'repair the queue boundary',budgetChars: 1800,
      session: { sessionId: 'su-knowledge-dedup',epoch: 0,port: 'turn-start' } };
    // A historical stable id alone does not prove this revision was delivered.
    sqlMockState.rows = [{ ref: 'report:fixture',epoch: 0 }];
    expect(await buildMemoryContextBlock(input)).toContain('[report fixture] cited report section');
    sqlMockState.rows = [{ ref: 'report:fixture',epoch: 0,
      source_fingerprint: reportVersion.fingerprint, source_version: reportVersion }];
    const block = await buildMemoryContextBlock(input);
    expect(block).toContain('retain verified snapshot');
    expect(block).toContain('[doc fixture] cited doc section');
    expect(block).not.toContain('[report fixture] cited report section');
  });
  const oneLine = (over: Partial<CorpusIoStub> = {}): CorpusIoStub => ({
    block: null,
    lines: [{ line: '- [work-item WI-6512] a pointer', score: 1,
      handle: { kind: 'work-item', ref: 'work-item:WI-6512', query: ['pointer'], resolve: 'work_items:get { id: "WI-6512" }' } }],
    dropped: [],
    embedderAvailable: true,
    candidateCount: 4,
    ...over,
  });

  const run = async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    return await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why did the corpus leg return that',
    });
  };

  const runWithSession = async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    return await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why did the corpus leg return that',
      session: { sessionId: 'su-ambient-fence', epoch: 0, port: 'mid-turn' },
    });
  };

  it('passes the durable ambient exclusion fence into corpus retrieval', async () => {
    corpusIoResult = oneLine({ embedderAvailable: true });
    sqlMockState.rows = [{ ambient_excluded_refs: ['WI-40293'] }];
    await runWithSession();

    const passed = recallCorpusContext.mock.calls.at(-1)?.[0] ?? {};
    expect(passed).toMatchObject({ ambientExcludedRefs: new Set(['WI-40293']) });
  });

  it.each([
    ['a missing session brief row', []],
    ['a legacy row with a NULL fence', [{ ambient_excluded_refs: null }]],
  ])('treats %s as an available empty fence', async (_label, rows) => {
    corpusIoResult = oneLine({ embedderAvailable: true });
    sqlMockState.rows = rows;
    await runWithSession();

    const passed = recallCorpusContext.mock.calls.at(-1)?.[0] as {
      ambientExcludedRefs?: ReadonlySet<string>;
    };
    expect([...passed.ambientExcludedRefs ?? []]).toEqual([]);
  });

  it('fails closed before corpus retrieval when the durable fence is malformed', async () => {
    corpusIoResult = oneLine({ embedderAvailable: true });
    sqlMockState.rows = [{ ambient_excluded_refs: ['WI-40293', 42] }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const callsBefore = recallCorpusContext.mock.calls.length;
      const block = await runWithSession();
      expect(recallCorpusContext.mock.calls.length).toBe(callsBefore);
      expect(block).not.toContain(CORPUS_BLOCK_HEADING);
    } finally {
      warn.mockRestore();
    }
  });

  it('hands the corpus leg the caller’s OWNER id, so its self-echo filter can fire', async () => {
    // EI-19460887729945170 — the wiring regression that shipped. This value has
    // always been the per-agent coord ownerId (`su-xxxx…`; claim-port.ts:47),
    // but it used to be passed as `excludeSessionId` and compared against hits'
    // NATIVE transcript uuids — two identity spaces, never equal — so the
    // self-session filter never fired once in production. Asserting the FIELD,
    // not just the value, is the point: a rename back would restore the bug
    // silently, with every other test still green.
    corpusIoResult = oneLine({ embedderAvailable: true });
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why did the corpus leg return that',
      session: { sessionId: 'su-be34c423', port: 'mid-turn' },
    });
    const passed = recallCorpusContext.mock.calls.at(-1)?.[0] ?? {};
    expect(passed).toMatchObject({ excludeOwnerId: 'su-be34c423' });
    expect(passed).not.toHaveProperty('excludeSessionId');
  });

  it('hands the corpus leg the caller’s active work-item scope for pointer labels', async () => {
    corpusIoResult = oneLine({ embedderAvailable: true });
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why did the corpus leg return that',
      session: {
        sessionId: 'su-scope',
        port: 'mid-turn',
        currentWorkItemId: 'WI-38148',
      },
    });
    const passed = recallCorpusContext.mock.calls.at(-1)?.[0] ?? {};
    expect(passed).toMatchObject({ declaredWorkItemId: 'WI-38148' });
  });

  it('WARNS when the leg ran BM25-only, and throttles the re-warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = oneLine({ embedderAvailable: false });
      await run();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('BM25-ONLY');
      expect(warn.mock.calls[0]![0]).toContain('candidates=4 admitted=1');

      // Second degraded injection inside the window: counted, not re-printed.
      // A one-shot warn is how a persistent embedder outage goes quiet.
      await run();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when the semantic half actually ran', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = oneLine({ embedderAvailable: true });
      await run();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['disabled', 'no-query', 'timed-out', 'failed'] as const)(
    'does not claim BM25 ran for a %s corpus leg or consume its warning window',
    async (outcome) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        corpusIoResult = oneLine({
          lines: [], candidateCount: 0, embedderAvailable: false, outcome,
        });
        const block = await run();
        expect(block).toContain('alpha');
        expect(block?.includes('Memory retrieval was DEGRADED'))
          .toBe(outcome === 'timed-out' || outcome === 'failed');
        expect(warn).not.toHaveBeenCalled();

        corpusIoResult = oneLine({ embedderAvailable: false });
        await run();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain('BM25-ONLY');
      } finally {
        warn.mockRestore();
      }
    },
  );

  /**
   * THE REGRESSION THIS ITEM IS REALLY ABOUT. Pre-P-001 the leg returned a bare
   * `null` when nothing was admitted, so an empty pointer section and a leg
   * that never ran were indistinguishable — and the one fact that explains the
   * emptiness (was semantic even reachable?) was destroyed at exactly the
   * moment it mattered most.
   */
  it('a leg that RAN and admitted nothing still reports HOW it ran', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = oneLine({ lines: [], embedderAvailable: false, candidateCount: 7 });
      const block = await run();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('candidates=7 admitted=0');
      // Retrieval found 7 and selection rejected all of them — the block is
      // unchanged, which is why the log line is the only place this is visible.
      expect(block).not.toContain(CORPUS_BLOCK_HEADING);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the leg never ran at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = null; // the stub throws ⇒ startCorpusLeg degrades to null
      await run();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * EI-16220 — the SILENT half of this same regression, and the reason it went
   * unnoticed: the coverage gate's notice is attached to the pointer LINES, so
   * a leg with no lines cannot render it. That makes the notice structurally
   * unreachable on exactly the turns that lost the most context — the turn is
   * quietly context-poor and the agent has no way to tell.
   *
   * Measured 2026-09-05 over 7 days of harness_shared.memory_recall_stats:
   * 11.77% of this workspace's recalls (18,580 of 157,902) ended 'timed-out',
   * every one of them silently.
   */
  it('marks a TIMED-OUT corpus leg so the turn knows its context is incomplete', async () => {
    corpusIoResult = oneLine({ lines: [], candidateCount: 0, outcome: 'timed-out' });
    const block = await run();
    expect(block).toContain('Memory retrieval was DEGRADED');
    expect(block).toContain('timed-out');
    // The marker must carry recovery that does not assume this recipient's role.
    expect(block).toContain('authorized memory reader');
    expect(block).not.toContain('memory:search');
  });

  it('marks a FAILED corpus leg the same way', async () => {
    corpusIoResult = oneLine({ lines: [], candidateCount: 0, outcome: 'failed' });
    const block = await run();
    expect(block).toContain('Memory retrieval was DEGRADED');
    expect(block).toContain('authorized memory reader');
    expect(block).not.toContain('memory:search');
  });

  /**
   * The control that keeps the marker worth reading. A leg that ran fine and
   * had nothing to say has lost NOTHING; marking that case would fire the
   * warning on ordinary turns and train the reader to skip it on the turns
   * where it is real. Without this test the fix above passes just as well
   * while emitting the marker unconditionally.
   */
  it('stays SILENT when the leg ran fine and simply found nothing', async () => {
    corpusIoResult = oneLine({ lines: [], candidateCount: 0, outcome: 'ok' });
    expect(await run()).not.toContain('Memory retrieval was DEGRADED');
  });

  it('renders the pointer section identically whether or not the embedder ran', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = oneLine({ embedderAvailable: true });
      const healthy = await run();
      _resetCorpusLegHealthForTests();
      corpusIoResult = oneLine({ embedderAvailable: false });
      const degraded = await run();
      expect(degraded).toBe(healthy);
      expect(healthy).toContain(CORPUS_BLOCK_HEADING);
      expect(healthy).toContain('- [work-item WI-6512] a pointer');
    } finally {
      warn.mockRestore();
    }
  });
});

/** P-009 — the corpus leg shares the existing one-row admission telemetry. */
describe('records the corpus admission funnel on the same recall row (P-009)', () => {
  it.each(['degraded', 'unavailable', 'error'] as const)(
    'retains delivered corpus execution receipts when memory exits early: %s', async (failure) => {
      const backend = mockBackend([], { ok: failure !== 'unavailable' });
      if (failure === 'error') backend.available = vi.fn(async () => { throw new Error('memory probe failed'); });
      useBackend(backend);
      if (failure === 'degraded') noteMemoryFailure(new MemoryTimeoutError('prior recall timed out'));
      const first = { ...legsWith(0), lexical: { ...legsWith(0).lexical, sourceCalls: [
        { source: 'plan', ranker: 'lexical', status: 'timed-out', rows: null, durationMs: 200, reason: 'source deadline' },
      ] } };
      const second = legsWith(3);
      corpusIoResult = oneLine({ legs: second, stages: [first, second] });
      try {
        const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws',
          queryContext: 'why did the corpus leg return that' });
        expect(block).toContain('work-item WI-6512');
        expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
        expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
          legs: null,
          admission: { returned: 0, admitted: 0, corpus: {
            outcome: 'ok', returned: 4, selected: 1, admitted: 1,
            sessionDedup: 0, embedderAvailable: true, retrievalDepth: 24, rerank: 'reranked',
            dropped: { 'ambient-excluded': 1, 'no-term-overlap': 1, 'budget-exhausted': 1 },
            legs: second, stages: [first, second], gate: null,
          } },
        });
        expect(backend.search).not.toHaveBeenCalled();
      } finally { resetMemoryDegradedForTest(); }
    },
  );
  it('retains the source receipts from every cascade stage on the same telemetry row', async () => {
    const first = { ...legsWith(0),lexical: { ...legsWith(0).lexical,sourceCalls: [
      { source: 'plan',ranker: 'lexical',status: 'timed-out' as const,rows: null,durationMs: 200,reason: 'source deadline' },
    ] } };
    const second = legsWith(1);
    const correlationIds = ['650e8400-e29b-41d4-a716-446655440000'];
    const partialSourceCalls = [{
      correlationId: correlationIds[0],
      stage: 'and' as const,
      source: 'plan',
      ranker: 'lexical',
      outcome: 'timed-out' as const,
    }];
    corpusIoResult = oneLine({
      legs: second,
      stages: [first,second],
      correlationIds,
      partialSourceCalls,
      partialSourceCallsTruncated: true,
    });
    const corpus = await run();
    expect(corpus).toMatchObject({
      stages: [first,second],
      correlationIds,
      partialSourceCalls,
      partialSourceCallsTruncated: true,
    });
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const oneLine = (over: Partial<CorpusIoStub> = {}): CorpusIoStub => ({
    block: null,
    lines: [{ line: '- [work-item WI-6512] a pointer', score: 1,
      handle: { kind: 'work-item', ref: 'work-item:WI-6512', query: ['pointer'], resolve: 'work_items:get { id: "WI-6512" }' } }],
    dropped: [
      { ref: 'work-item:WI-excluded', reason: 'ambient-excluded' },
      { ref: 'work-item:WI-drop-1', reason: 'no-term-overlap' },
      { ref: 'work-item:WI-drop-2', reason: 'budget-exhausted' },
    ],
    embedderAvailable: true,
    candidateCount: 4,
    outcome: 'ok',
    rerank: 'reranked',
    legs: legsWith(3),
    retrievalDepth: 24,
    ...over,
  });

  const run = async (session = false) => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why did the corpus leg return that',
      ...(session ? { session: { sessionId: 'su-corpus', epoch: 0, port: 'mid-turn' } } : {}),
    });
    await flush();
    return (
      recordRecallStatsMock.mock.calls.at(-1)![1] as {
        admission: {
          corpus: null | {
            outcome: string;
            returned: number;
            selected: number;
            admitted: number;
            timeout?: { scope: string; phase: string; elapsedMs: number };
            sessionDedup: number;
            embedderAvailable: boolean;
            retrievalDepth: number;
            rerank: string;
            dropped: Record<string, number>;
            gate: { verdict: string; dropped: number } | null;
            correlationIds?: string[];
            partialSourceCalls?: Record<string, unknown>[];
            partialSourceCallsTruncated?: boolean;
          };
        };
      }
    ).admission.corpus;
  };

  it('separates returned, selected, and admitted while accounting for selection losses', async () => {
    corpusIoResult = oneLine();
    const corpus = await run();
    expect(corpus).toMatchObject({
      outcome: 'ok',
      returned: 4,
      selected: 1,
      admitted: 1,
      sessionDedup: 0,
      embedderAvailable: true,
      retrievalDepth: 24,
      rerank: 'reranked',
      dropped: { 'ambient-excluded': 1, 'no-term-overlap': 1, 'budget-exhausted': 1 },
    });
    expect(Object.keys(corpus!.dropped).sort()).toEqual([
      'ambient-excluded',
      'budget-exhausted',
      'cap-exhausted',
      'duplicate-ref',
      'no-term-overlap',
      'not-novel',
      'out-of-scope',
      'self-session',
    ]);
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
  });

  it('carries corpus timeout diagnostics into the shared admission row', async () => {
    const timeout = { scope: 'backend-operation' as const, phase: 'corpus-leg' as const, elapsedMs: 2000 };
    corpusIoResult = oneLine({ lines: [], candidateCount: 0, outcome: 'timed-out', timeout });
    const corpus = await run();
    expect(corpus).toMatchObject({ outcome: 'timed-out', timeout });
  });

  it('retains corpus diagnostics when recall throws a timeout instead of returning a result', async () => {
    recallCorpusContext.mockImplementationOnce(async () => {
      throw new MemoryTimeoutError('corpus recall timed out', 'backend-operation', 'corpus-leg', 2000);
    });
    const corpus = await run();
    expect(corpus).toMatchObject({
      outcome: 'timed-out',
      timeout: { scope: 'backend-operation', phase: 'corpus-leg', elapsedMs: 2000 },
      selected: 0,
      sessionDedup: 0,
    });
  });

  it('attributes coverage-gate suppression instead of reporting an unexplained empty leg', async () => {
    corpusIoResult = oneLine({ legs: legsWith(0) });
    coverageReport = coverageOf('degraded', { coverage: 0.01, embeddedRows: 9 });
    const corpus = await run();
    expect(corpus).toMatchObject({
      returned: 4,
      selected: 1,
      admitted: 0,
      gate: { verdict: 'sit-out', dropped: 1 },
    });
  });

  it('counts cross-moment corpus dedup separately from pure selection drops', async () => {
    corpusIoResult = oneLine();
    const sourceVersion = contextSourceVersion({ namespace: 'corpus:work_item:ws', ref: 'work-item:WI-6512',
      fullText: 'canonical body', revision: null, updatedAt: null,
      validity: { status: 'unknown', validAt: null, invalidAt: null, supersededBy: null } });
    corpusIoResult.lines[0].sourceVersion = sourceVersion;
    sqlMockState.rows = [{ ref: 'work-item:WI-6512', epoch: 0, source_fingerprint: sourceVersion.fingerprint }];
    const corpus = await run(true);
    expect(corpus).toMatchObject({ selected: 1, admitted: 0, sessionDedup: 1 });
  });

  it('replays corpus sources with missing or stale canonical identities and offers the current version to the native receipt seam', async () => {
    useBackend(mockBackend([]));
    const ref = 'plan:papercusp:repair';
    const body = 'http2 transport requires approval';
    const input = { namespace: 'corpus:plan:ws', ref, fullText: body, revision: 'r1', updatedAt: null,
      validity: { status: 'current' as const, validAt: null, invalidAt: null, supersededBy: null } };
    const first = contextSourceVersion(input);
    const corrected = contextSourceVersion({ ...input, fullText: body + ' and independent review', revision: 'r2' });
    const line = { line: `- [plan] source-evidence ${JSON.stringify(body)}`, score: 1, operative: true,
      handle: { kind: 'plan' as const, ref, query: ['http2'], resolve: 'plans:get' } };
    const recall = { userId: 'u1', workspaceId: 'ws', queryContext: 'http2 transport approval',
      session: { sessionId: 'su-corpus-version', epoch: 2, port: 'mid-turn' } };
    for (const persisted of [{ ref }, { ref, source_fingerprint: first.fingerprint, source_version: first }]) {
      sqlMockState.rows = [persisted];
      corpusIoResult = oneLine({ lines: [{ ...line, sourceVersion: corrected }] });
      const result = await prepareMemoryContextBlock(recall);
      expect(result?.text).toContain(body);
      expect(result?.text?.includes('source-change')).toBe('source_version' in persisted);
      expect(result?.fragments.filter(fragment => fragment.kind === 'corpus')).toMatchObject([
        { id: ref, sourceFingerprint: corrected.fingerprint, sourceVersion: corrected },
      ]);
    }
    sqlMockState.rows = [{ ref, source_fingerprint: corrected.fingerprint }];
    corpusIoResult = oneLine({ lines: [{ ...line, sourceVersion: corrected }] });
    expect((await prepareMemoryContextBlock(recall))?.fragments ?? []).toEqual([]);
    corpusIoResult = oneLine({ lines: [line] });
    expect((await prepareMemoryContextBlock(recall))?.text).toContain(body);
    // The whole source+correction unit is omitted when its notice would exceed
    // the corpus budget; neither the instruction nor a receipt can escape alone.
    sqlMockState.rows = [{ ref, source_fingerprint: first.fingerprint, source_version: first }];
    corpusIoResult = oneLine({ lines: [{ ...line, line: line.line + 'x'.repeat(1700), sourceVersion: corrected }] });
    const withheld = await prepareMemoryContextBlock(recall);
    expect(withheld?.text ?? '').not.toContain(body);
    expect(withheld?.fragments ?? []).toEqual([]);
  });

  it('rechecks cached corpus offers against current authority and denial on each receipt attempt', async () => {
    useBackend(mockBackend([]));
    const ref = 'plan:papercusp:freshness';
    const source = contextSourceVersion({ namespace: 'corpus:plan:ws', ref, fullText: 'http2 requires approval',
      revision: 'r1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const changed = contextSourceVersion({ namespace: source.namespace, ref, fullText: 'http2 requires independent approval',
      revision: 'r2', updatedAt: null, validity: source.validity });
    corpusIoResult = oneLine({ lines: [{ line: '- [plan] source-evidence "http2 requires approval"',
      score: 1, operative: true, sourceVersion: source,
      handle: { kind: 'plan', ref, query: ['http2'], resolve: 'plans:get' } }] });
    const due = vi.spyOn(corpusLedger, 'corpusSourcesDueForRevalidation').mockResolvedValue([]);
    const knowledge = vi.spyOn(knowledgeSources, 'revalidateKnowledgeSourceVersions').mockResolvedValue([source]);
    const reports = vi.spyOn(reportSources, 'revalidateReportSourceVersions').mockResolvedValue([]);
    try {
      const prepared = await prepareMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'http2 approval',
        session: { sessionId: 'su-corpus-freshness', epoch: 3, port: 'mid-turn' } });
      const fragment = prepared!.fragments.find(row => row.kind === 'corpus')!;
      expect((await fragment.revalidateSource!(new AbortController().signal))?.fingerprint).toBe(source.fingerprint);
      knowledge.mockResolvedValue([changed]);
      expect((await fragment.revalidateSource!(new AbortController().signal))?.fingerprint).toBe(changed.fingerprint);
      knowledge.mockResolvedValue([]);
      expect(await fragment.revalidateSource!(new AbortController().signal)).toBeNull();
      expect(knowledge).toHaveBeenCalledTimes(3);
    } finally { due.mockRestore(); knowledge.mockRestore(); reports.mockRestore(); }
  });

  it('offers content-free lifecycle notices for confirmed sources absent from ranked results and never stamps on read', async () => {
    useBackend(mockBackend([]));
    const ref = 'plan:papercusp:disappeared';
    const previous = contextSourceVersion({ namespace: 'corpus:plan:ws', ref, fullText: 'Earlier private guidance',
      revision: 'r1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const closed = contextSourceVersion({ namespace: previous.namespace, ref, fullText: 'Earlier private guidance',
      revision: 'r2', updatedAt: null,
      validity: { status: 'retracted', validAt: null, invalidAt: null, supersededBy: null } });
    corpusIoResult = oneLine({ lines: [] });
    sqlMockState.rows = [{ ref, source_fingerprint: previous.fingerprint, source_version: previous }];
    const knowledge = vi.spyOn(knowledgeSources, 'revalidateKnowledgeSourceVersions').mockResolvedValue([closed]);
    const reports = vi.spyOn(reportSources, 'revalidateReportSourceVersions').mockResolvedValue([]);
    const due = vi.spyOn(corpusLedger, 'corpusSourcesDueForRevalidation').mockResolvedValue([previous]);
    const input = { userId: 'u1', workspaceId: 'ws', queryContext: 'unrelated current task',
      session: { sessionId: 'su-disappeared-source', epoch: 2, port: 'mid-turn' } };
    try {
      const result = await prepareMemoryContextBlock(input);
      expect(result?.text).toContain('withdraw-earlier-version');
      expect(result?.text?.match(/source-change /g)).toHaveLength(1);
      expect(result?.text).not.toContain('Earlier private guidance');
      expect(result?.fragments).toMatchObject([{ kind: 'corpus', id: ref, sourceVersion: closed }]);
      expect(sqlMockState.statements.some(statement => /INSERT INTO harness_shared.corpus_session_surfaced/.test(statement))).toBe(false);
      knowledge.mockResolvedValue([]); // unavailable or no longer authorized is unknown
      expect((await prepareMemoryContextBlock(input))?.text ?? '').not.toContain('source-change');
      expect((await prepareMemoryContextBlock({ ...input, knowledgeSourcesAllowed: false }))?.text ?? '').not.toContain('source-change');
    } finally { knowledge.mockRestore(); reports.mockRestore(); due.mockRestore(); }
  });

  it('records null when the corpus leg did not return a typed result', async () => {
    corpusIoResult = null;
    expect(await run()).toBeNull();
    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * context-injection-retrieval-reach-and-visibility-2026-08-03 P-003 —
 * COVERAGE-GATED DEGRADATION reaches the rendered block.
 *
 * `corpus-coverage-gate.test.ts` proves the DECISION in isolation. These cases
 * prove the WIRING, which is the half a pure test cannot reach and the half that
 * actually shipped broken before: the gate can be perfectly correct and still be
 * invisible if injection never consults it, never renders its notice, or
 * (measurably worse) suppresses when it should not.
 *
 * The fail-open case is asserted FIRST and deliberately: an unreadable gate must
 * leave the block byte-identical to the pre-P-003 output. A coverage feature
 * whose failure mode is "silently delete the pointer section" would be a worse
 * defect than the silent confidence it was built to remove.
 */
describe('coverage-gated degradation reaches the block (P-003)', () => {
  const oneLine = (over: Partial<CorpusIoStub> = {}): CorpusIoStub => ({
    block: null,
    lines: [{ line: '- [work-item WI-6512] a pointer', score: 1,
      handle: { kind: 'work-item', ref: 'work-item:WI-6512', query: ['pointer'], resolve: 'work_items:get { id: "WI-6512" }' } }],
    dropped: [],
    embedderAvailable: true,
    candidateCount: 4,
    legs: legsWith(12),
    retrievalDepth: 24,
    ...over,
  });

  const run = async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    return await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why did the corpus leg return that',
    });
  };

  it('delivers memory without waiting on index coverage when corpus retrieval is disabled', async () => {
    corpusIoResult = oneLine({ lines: [], candidateCount: 0, embedderAvailable: false, outcome: 'disabled' });
    const coverage = vi.spyOn(coverageGate, 'loadCoverageSnapshotCached')
      .mockImplementation(() => new Promise(() => {})).mockClear();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deadline = createMemoryWorkDeadline(1000);
    try {
      useBackend(mockBackend([{ id: 'm1', text: 'useful disabled-corpus recall' }]));
      const block = await buildMemoryContextBlock({
        userId: 'u1', workspaceId: 'ws', queryContext: 'disabled corpus recall', deadline,
      });
      expect(block).toContain('useful disabled-corpus recall');
      expect(block).not.toContain('DEGRADED');
      expect(warn).not.toHaveBeenCalled();
      expect(deadline.signal.aborted).toBe(false);
      expect(coverage).not.toHaveBeenCalled();
      expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
      expect(recordRecallStatsMock.mock.calls[0]?.[1]).toMatchObject({
        admission: { corpus: { outcome: 'disabled', gate: null } },
      });
    } finally {
      deadline.close();
      coverage.mockRestore();
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('renders unchanged when the gate cannot be evaluated (FAIL-OPEN)', async () => {
    corpusIoResult = oneLine();
    coverageReport = null; // ⇒ the stub throws ⇒ the gate lands in its catch
    const block = await run();
    expect(block).toContain('- [work-item WI-6512] a pointer');
    expect(block).not.toContain('DEGRADED');
  });

  it('renders unchanged when coverage is healthy', async () => {
    corpusIoResult = oneLine();
    coverageReport = coverageOf('healthy');
    const block = await run();
    expect(block).toContain('- [work-item WI-6512] a pointer');
    expect(block).not.toContain('DEGRADED');
  });

  it('marks the section — ABOVE the pointers — when coverage is degraded', async () => {
    corpusIoResult = oneLine();
    coverageReport = coverageOf('degraded', { coverage: 0.41, embeddedRows: 41_000 });
    const block = await run();
    expect(block).toContain('- [work-item WI-6512] a pointer');
    expect(block).toContain('DEGRADED');
    expect(block).toContain('41.0%');
    // Order matters: this section sits at the END of the injected block and is
    // the first thing a char budget truncates, so a trailing caveat can be cut
    // away from the pointers it qualifies — leaving them reading as confident.
    expect(block!.indexOf('DEGRADED')).toBeLessThan(block!.indexOf('WI-6512'));
  });

  it('SUPPRESSES the section when the index is unselective and lexical found nothing', async () => {
    corpusIoResult = oneLine({ legs: legsWith(0) });
    coverageReport = coverageOf('degraded', { coverage: 0.01, embeddedRows: 9 });
    const block = await run();
    // The pointers are gone AND so is the heading — a heading over an empty
    // section would be its own small dishonesty.
    expect(block).not.toContain('WI-6512');
    expect(block).not.toContain(CORPUS_BLOCK_HEADING);
    // The mem0 block is untouched: the gate governs the pointer section only.
    expect(block).toContain('alpha');
  });

  it('does NOT suppress the same unselective index when lexical contributed', async () => {
    // The control that makes the previous case meaningful. Identical coverage;
    // only the lexical leg differs. A gate keyed on coverage alone would delete
    // these pointers, which are sound BM25 matches.
    corpusIoResult = oneLine({ legs: legsWith(7) });
    coverageReport = coverageOf('degraded', { coverage: 0.01, embeddedRows: 9 });
    const block = await run();
    expect(block).toContain('- [work-item WI-6512] a pointer');
    expect(block).toContain('DEGRADED');
  });
});

/**
 * portable-identity-packages P-007 / D-021 — the turn-start push path takes the
 * package visibility path. The eligibility SQL and hit shaping are proven against
 * the real canonical store in blueprint/package-memory-visibility.integration.test.ts;
 * these pin that injection ROUTES through them: the session wearer's applied pins
 * reach the one multi-scope search as `archivedEligibility`, and pack hits are
 * deduped to one copy per item (the pinned exact version) before rendering.
 */
describe('identity-package eligibility on the push path (P-007)', () => {
  const ORGANIC = { id: '22222222-2222-4222-8222-222222222222', text: 'organic visibility note' };
  const packRow = (version: string, id: string) => ({
    id, text: `visibility pack note ${version}`,
    metadata: { source: 'pack', pack_id: 'visibility-pack', pack_item_id: 'shared', pack_version: version,
      identity_package_resource: `res-${version}` },
  });

  it("passes the session wearer's applied pins to the search and keeps only the pinned copy of an item", async () => {
    packPins.resolve = async () => new Set(['res-1.0.0']);
    // A promoted 2.0.0 copy of the same item is pool-wide; the wearer's pinned
    // 1.0.0 row must win the (pack_id, pack_item_id) dedupe.
    const backend = mockBackend([ORGANIC, packRow('2.0.0', '33333333-3333-4333-8333-333333333333'),
      packRow('1.0.0', '44444444-4444-4444-8444-444444444444')]);
    useBackend(backend);

    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'visibility pack note',
      harnessSlugs: ['papercusp'], potSlugs: [],
      session: { sessionId: 'wearer-a', port: 'turn-start' },
    });

    expect(packPins.calls).toEqual([{ workspaceId: 'ws', ownerId: 'wearer-a' }]);
    expect(backend.search.mock.calls[0][1]).toMatchObject({
      archivedEligibility: { key: 'identity_package_resource', values: ['res-1.0.0'] } });
    expect(block).toContain('organic visibility note');
    expect(block).toContain('visibility pack note 1.0.0');
    expect(block).not.toContain('visibility pack note 2.0.0');
  });

  it('resolves no pins and requests no archived rows without a session wearer', async () => {
    packPins.resolve = async () => new Set(['res-1.0.0']);
    const backend = mockBackend([ORGANIC]);
    useBackend(backend);

    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'visibility pack note',
      harnessSlugs: ['papercusp'], potSlugs: [],
    });

    expect(block).toContain('organic visibility note');
    expect(packPins.calls).toEqual([]);
    expect(backend.search.mock.calls[0][1]).not.toHaveProperty('archivedEligibility');
  });

  it('refreshes exact package pins once per confirmation attempt and rejects a revoked cached offer', async () => {
    const rows = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
      .map((id, index) => ({ ...packRow('1.0.0', id), scope: 'harness:papercusp',
        text: index === 0 ? 'visibility pack note: independent approval before execution'
          : 'visibility pack note: retain a rollback snapshot before migration',
        metadata: { ...packRow('1.0.0', id).metadata, pack_item_id: `item-${index}`, validity: { status: 'current' } } }));
    let pinned = new Set(['res-1.0.0']);
    packPins.resolve = async () => pinned;
    const backend = Object.assign(mockBackend(rows), {
      get: vi.fn(async () => { throw new Error('unscoped package read forbidden'); }),
      // Deliberately return the row even after revocation: the caller must
      // independently check its current pins, not trust the cached offer.
      listPage: vi.fn(async (options: { archivedEligibility?: unknown }) => ({
        entries: options.archivedEligibility ? rows : [], total: options.archivedEligibility ? rows.length : 0 })),
    });
    useBackend(backend);
    const prepared = await prepareMemoryContextBlock({ userId: null, workspaceId: 'ws',
      harnessSlugs: ['papercusp'], potSlugs: [], queryContext: 'visibility pack note', budgetChars: 2400,
      session: { sessionId: 'wearer-a', epoch: 2, port: 'turn-start' } });
    const fragments = prepared!.fragments.filter(row => row.kind === 'memory');
    expect(fragments).toHaveLength(2);
    expect(packPins.calls).toHaveLength(1);
    const signal = new AbortController().signal;
    expect(await Promise.all(fragments.map(row => row.revalidateSource!(signal))))
      .toEqual(fragments.map(row => row.sourceVersion));
    expect(packPins.calls).toHaveLength(2);
    expect(backend.listPage).toHaveBeenLastCalledWith({ scope: 'harness:papercusp', ids: rows.map(row => row.id),
      includeSuperseded: true, archivedEligibility: { key: 'identity_package_resource', values: ['res-1.0.0'] },
      offset: 0, limit: 8 });
    pinned = new Set(['res-2.0.0']);
    expect(await fragments[0].revalidateSource!(new AbortController().signal)).toBeNull();
    await expect(stageMemoryEmission(getOrgPg().sql, 'wearer-a', 'revoked-package-attempt', fragments))
      .rejects.toThrow('Memory emission source changed or is unavailable');
    expect(packPins.calls).toHaveLength(4);
    expect(packPins.calls.every(call => call.workspaceId === 'ws' && call.ownerId === 'wearer-a')).toBe(true);
    expect(backend.get).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'foreign-pool', 'malformed-provenance', 'read-error'])(
    'keeps a confirmed package lifecycle unknown under %s authority', async scenario => {
      const id = '44444444-4444-4444-8444-444444444444';
      const before = contextSourceVersion({ namespace: 'memory:harness:papercusp', ref: id,
        fullText: 'Earlier private package guidance', revision: null, updatedAt: null,
        validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
      packPins.resolve = async () => scenario === 'revoked' ? new Set() : new Set(['res-1.0.0']);
      const row = { ...packRow('1.0.0', id), scope: scenario === 'foreign-pool' ? 'harness:foreign' : 'harness:papercusp',
        metadata: { ...packRow('1.0.0', id).metadata, pack_version: scenario === 'malformed-provenance' ? '' : '1.0.0',
          validity: { status: 'current' } } };
      const backend = Object.assign(mockBackend([]), {
        get: vi.fn(async () => { throw new Error('unscoped package read forbidden'); }),
        listPage: vi.fn(async (options: { archivedEligibility?: unknown }) => {
          if (scenario === 'read-error') throw new Error('canonical package read unavailable');
          return options.archivedEligibility ? { entries: [row], total: 1 } : { entries: [], total: 0 };
        }),
      });
      const due = vi.spyOn(memoryLedger, 'memorySourcesDueForRevalidation').mockResolvedValue([before]);
      useBackend(backend);
      try {
        const prepared = await prepareMemoryContextBlock({ userId: null, workspaceId: 'ws',
          harnessSlugs: ['papercusp'], potSlugs: [], queryContext: 'unrelated task', budgetChars: 1400,
          session: { sessionId: 'wearer-a', epoch: 2, port: 'mid-turn' } });
        expect(prepared?.text ?? '').not.toContain('source-change');
        expect(prepared?.text ?? '').not.toContain('package guidance');
        expect(prepared?.fragments ?? []).toEqual([]);
        expect(backend.get).not.toHaveBeenCalled();
      } finally { due.mockRestore(); }
    });

  it('revalidates a pinned archived package absent from search without replaying its private prose', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    packPins.resolve = async () => new Set(['res-1.0.0']);
    const before = contextSourceVersion({ namespace: 'memory:harness:papercusp', ref: id,
      fullText: 'Earlier private package guidance', revision: null, updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const row = { ...packRow('1.0.0', id), scope: 'harness:papercusp',
      metadata: { ...packRow('1.0.0', id).metadata, validity: { status: 'current' } } };
    const backend = Object.assign(mockBackend([]), {
      listPage: vi.fn(async () => ({ entries: [row], total: 1 })),
    });
    const due = vi.spyOn(memoryLedger, 'memorySourcesDueForRevalidation').mockResolvedValue([before]);
    useBackend(backend);
    try {
      const prepared = await prepareMemoryContextBlock({ userId: null, workspaceId: 'ws',
        harnessSlugs: ['papercusp'], potSlugs: [], queryContext: 'unrelated task', budgetChars: 1400,
        session: { sessionId: 'wearer-a', epoch: 2, port: 'mid-turn' } });
      expect(prepared?.text).toContain('replace-earlier-version');
      expect(prepared?.text).not.toContain('private package guidance');
      expect(prepared?.text).not.toContain('visibility pack note');
      expect(prepared?.fragments).toHaveLength(1);
      const fragment = prepared!.fragments[0];
      expect(await fragment.revalidateSource!(new AbortController().signal)).toEqual(fragment.sourceVersion);
      expect(backend.listPage).toHaveBeenCalledWith({ scope: 'harness:papercusp', ids: [id],
        includeSuperseded: true, archivedEligibility: { key: 'identity_package_resource', values: ['res-1.0.0'] },
        offset: 0, limit: 8 });
    } finally { due.mockRestore(); }
  });

  it('confirms pool-wide promoted rows after detach with one fresh active-only batch per attempt', async () => {
    packPins.resolve = async () => new Set();
    const rows = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
      .map((id, index) => ({ ...packRow('1.0.0', id), scope: 'harness:papercusp',
        text: index === 0 ? 'visibility pack note: require independent approval'
          : 'visibility pack note: preserve the rollback snapshot',
        metadata: { ...packRow('1.0.0', id).metadata, pack_item_id: `public-item-${index}`,
          identity_package_promotion: { reviewed_by: 'reviewer', reason: 'pool-wide' }, validity: { status: 'current' } } }));
    let visible = true;
    let reads = 0;
    const backend = Object.assign(mockBackend(rows), {
      get: vi.fn(async () => { throw new Error('unscoped package read forbidden'); }),
      listPage: vi.fn(async (_options: unknown) => {
        // The first read sees the row; withdrawal may race the second,
        // active-only read. Cached promotion metadata proves no visibility.
        const entries = ++reads % 2 === 1 || visible ? rows : [];
        return { entries, total: entries.length };
      }),
    });
    useBackend(backend);
    const prepared = await prepareMemoryContextBlock({ userId: null, workspaceId: 'ws',
      harnessSlugs: ['papercusp'], potSlugs: [], queryContext: 'visibility pack note', budgetChars: 2400,
      session: { sessionId: 'non-wearer', epoch: 2, port: 'turn-start' } });
    const fragments = prepared!.fragments.filter(row => row.kind === 'memory');
    expect(fragments).toHaveLength(2);
    const newSharedSignal = new AbortController().signal;
    expect(await Promise.all(fragments.map(row => row.revalidateSource!(newSharedSignal))))
      .toEqual(fragments.map(row => row.sourceVersion));
    expect(backend.listPage).toHaveBeenCalledTimes(2);
    expect(backend.listPage.mock.calls.map(call => call[0])).toEqual([0, 1].map(() => ({
      scope: 'harness:papercusp', ids: rows.map(row => row.id), includeSuperseded: true, offset: 0, limit: 8 })));
    visible = false;
    expect(await fragments[0].revalidateSource!(new AbortController().signal)).toBeNull();
    await expect(stageMemoryEmission(getOrgPg().sql, 'non-wearer', 'withdrawn-promotion', fragments))
      .rejects.toThrow('Memory emission source changed or is unavailable');
    expect(backend.get).not.toHaveBeenCalled();
  });

  it.each(['current', 'retracted'] as const)(
    'revalidates a promoted package absent from search with current pool-wide %s evidence', async status => {
      packPins.resolve = async () => new Set();
      const id = '44444444-4444-4444-8444-444444444444';
      const before = contextSourceVersion({ namespace: 'memory:harness:papercusp', ref: id,
        fullText: 'Earlier private package guidance', revision: null, updatedAt: null,
        validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
      const row = { ...packRow('1.0.0', id), scope: 'harness:papercusp',
        metadata: { ...packRow('1.0.0', id).metadata,
          identity_package_promotion: { reviewed_by: 'reviewer', reason: 'pool-wide' }, validity: { status } } };
      const backend = Object.assign(mockBackend([]), {
        listPage: vi.fn(async (_options: unknown) => ({ entries: [row], total: 1 })),
      });
      const due = vi.spyOn(memoryLedger, 'memorySourcesDueForRevalidation').mockResolvedValue([before]);
      useBackend(backend);
      try {
        const prepared = await prepareMemoryContextBlock({ userId: null, workspaceId: 'ws',
          harnessSlugs: ['papercusp'], potSlugs: [], queryContext: 'unrelated task', budgetChars: 1400,
          session: { sessionId: 'non-wearer', epoch: 2, port: 'mid-turn' } });
        expect(prepared?.text).toContain(status === 'current' ? 'replace-earlier-version' : 'withdraw-earlier-version');
        expect(prepared?.text).not.toContain('private package guidance');
        expect(prepared?.text).not.toContain('visibility pack note');
        expect(prepared?.fragments).toHaveLength(1);
        const fragment = prepared!.fragments[0];
        expect(await fragment.revalidateSource!(new AbortController().signal)).toEqual(fragment.sourceVersion);
        expect(backend.listPage).toHaveBeenCalledTimes(4);
        expect(backend.listPage.mock.calls.map(call => call[0])).toEqual([0, 1, 2, 3].map(() => ({
          scope: 'harness:papercusp', ids: [id], includeSuperseded: true, offset: 0, limit: 8 })));
      } finally { due.mockRestore(); }
    });
});

describe('Jev on the push path (plan jev-decision-model-integration-2026-09-29, P-007/P-008, D-009)', () => {
  const ROWS = [
    { id: 'mj1', text: 'the deploy runs from papercup-release' },
    { id: 'mj2', text: 'the tabs toolbar uses a 12px gap' },
  ];
  const INPUT = { userId: 'u1', workspaceId: 'ws', queryContext: 'where does the deploy run from' };
  /** Answer every question in request order with the given P(yes) values. */
  const answering = (pYes: number[]) => {
    const calls: Array<{ request: { questions: Record<string, unknown> }; options?: unknown }> = [];
    jev.decide = async (request, options) => {
      calls.push({ request, options });
      const answers = Object.fromEntries(Object.keys(request.questions).map((id, i) => [id, { type: 'yesNo', pYes: pYes[i] ?? 1 }]));
      return { kind: 'answered', model: 'jev-1.13.0', answers, usage: { inputTokens: 1, outputTokens: 0 }, latencyMs: 5, attempts: 1 };
    };
    return calls;
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const baseline = async (): Promise<string | null> => {
    jev.mode = 'off';
    useBackend(mockBackend(ROWS));
    return buildMemoryContextBlock(INPUT);
  };

  it('Off (the default) never builds a client, makes zero decide() calls, and injects both memories', async () => {
    const calls = answering([0, 0]);
    const block = await baseline();
    expect(jev.clientBuilt).toBe(0);
    expect(calls).toHaveLength(0);
    expect(block).toContain(ROWS[0]!.text);
    expect(block).toContain(ROWS[1]!.text);
  });

  it('Log only fires ONE memory-injection request and injects the byte-identical block', async () => {
    const off = await baseline();
    jev.mode = 'shadow';
    const calls = answering([0.9, 0.01]);
    useBackend(mockBackend(ROWS));
    const block = await buildMemoryContextBlock(INPUT);
    await flush();
    expect(block).toBe(off);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ consumer: 'memory-injection', subjectIds: ['mj1', 'mj2'] });
  });

  it('On drops what Jev judges irrelevant and records the drop in the admission funnel', async () => {
    jev.mode = 'on';
    answering([0.9, 0.01]);
    useBackend(mockBackend(ROWS));
    const block = await buildMemoryContextBlock(INPUT);
    await flush();
    expect(block).toContain(ROWS[0]!.text);
    expect(block).not.toContain(ROWS[1]!.text);
    const { admission } = recordRecallStatsMock.mock.calls.at(-1)![1] as { admission: { dropped: Record<string, number> } };
    expect(admission.dropped.jev).toBe(1);
  });

  it('On fails open: an inconclusive answer or a throwing client injects exactly the Off block', async () => {
    const off = await baseline();
    jev.mode = 'on';
    jev.decide = async () => ({ kind: 'inconclusive', reason: 'timeout', latencyMs: 400, attempts: 1 });
    useBackend(mockBackend(ROWS));
    expect(await buildMemoryContextBlock(INPUT)).toBe(off);
    jev.decide = async () => {
      throw new Error('socket hang up');
    };
    useBackend(mockBackend(ROWS));
    expect(await buildMemoryContextBlock(INPUT)).toBe(off);
  });

  it('On never reorders: a kept set is injected in retrieval order', async () => {
    jev.mode = 'on';
    answering([0.9, 0.95]);
    useBackend(mockBackend(ROWS));
    const block = (await buildMemoryContextBlock(INPUT))!;
    expect(block.indexOf(ROWS[0]!.text)).toBeLessThan(block.indexOf(ROWS[1]!.text));
  });

  // WI-10004485: turn-start's build runs under a 2,000 ms deadline inside a 2,500 ms
  // wall, so the deadline ends first. A wait sized from the wall alone was cut off
  // by the deadline in On while the ledger recorded the call as answered.
  it('bounds the Jev wait by the build deadline, not only by the client wall', async () => {
    jev.mode = 'on';
    const calls = answering([0.9, 0.95]);
    useBackend(mockBackend(ROWS));
    const deadline = createMemoryWorkDeadline(1000);
    try {
      await buildMemoryContextBlock({ ...INPUT, deadline, respondByMs: Date.now() + 60_000 });
    } finally {
      deadline.close();
    }
    expect(calls).toHaveLength(1);
    const timeoutMs = (calls[0]!.options as { timeoutMs?: number }).timeoutMs!;
    // At most the deadline net of the 250 ms response margin; the 60 s wall would
    // have allowed the full 800 ms cap.
    expect(timeoutMs).toBeLessThanOrEqual(1000 - 250);
    expect(timeoutMs).toBeGreaterThanOrEqual(150);
  });

  it('records the Jev result in the admission funnel', async () => {
    jev.mode = 'on';
    answering([0.9, 0.01]);
    useBackend(mockBackend(ROWS));
    await buildMemoryContextBlock(INPUT);
    await flush();
    const { admission } = recordRecallStatsMock.mock.calls.at(-1)![1] as { admission: { jev?: Record<string, unknown> } };
    expect(admission.jev).toMatchObject({ effective: 'on', outcome: 'answered' });
    expect(typeof admission.jev!.budgetMs).toBe('number');
    expect(admission.jev).not.toHaveProperty('skipped');
  });

  it('with no time left to wait, neither On nor Log only calls Jev, and the funnel counts the skip', async () => {
    const off = await baseline();
    for (const mode of ['on', 'shadow'] as const) {
      jev.mode = mode;
      const calls = answering([0.9, 0.01]);
      useBackend(mockBackend(ROWS));
      // 350 ms of deadline, net of the 250 ms margin, is under the 150 ms floor.
      const deadline = createMemoryWorkDeadline(350);
      let block: string | null;
      try {
        block = await buildMemoryContextBlock({ ...INPUT, deadline });
      } finally {
        deadline.close();
      }
      await flush();
      expect(calls).toHaveLength(0);
      expect(block).toBe(off);
      const { admission } = recordRecallStatsMock.mock.calls.at(-1)![1] as { admission: { jev?: Record<string, unknown> } };
      expect(admission.jev).toMatchObject({ effective: mode, skipped: 'no-time' });
    }
  });

  // WI-10004485 step D (staging, 2026-10-01): a stale-while-revalidate rebuild answers
  // nobody, yet sized from the hook wall it skipped Jev with budgets down to
  // -2,175 ms while its own deadline still had time. The wall applies only while a
  // caller waits.
  it('once no caller waits, the client wall no longer bounds Jev; the build deadline still does', async () => {
    jev.mode = 'on';
    const calls = answering([0.9, 0.95]);
    useBackend(mockBackend(ROWS));
    const deadline = createMemoryWorkDeadline(1000);
    try {
      // The wall passed 2 s ago; the build's own deadline has about 1 s left.
      await buildMemoryContextBlock({ ...INPUT, deadline, respondByMs: Date.now() - 2000, callerWaiting: () => false });
    } finally {
      deadline.close();
    }
    await flush();
    expect(calls).toHaveLength(1);
    const timeoutMs = (calls[0]!.options as { timeoutMs?: number }).timeoutMs!;
    expect(timeoutMs).toBeLessThanOrEqual(1000 - 250);
    expect(timeoutMs).toBeGreaterThanOrEqual(150);
    const { admission } = recordRecallStatsMock.mock.calls.at(-1)![1] as { admission: { jev?: Record<string, unknown> } };
    expect(admission.jev).toMatchObject({ effective: 'on', outcome: 'answered', callerWaiting: false });
    expect(admission.jev!.wallLeftMs as number).toBeLessThan(-1900);
    expect(admission.jev!.deadlineLeftMs as number).toBeGreaterThan(250);
  });

  it('while a caller still waits, a passed wall still skips Jev, and the funnel names that bound', async () => {
    const off = await baseline();
    jev.mode = 'on';
    const calls = answering([0.9, 0.95]);
    useBackend(mockBackend(ROWS));
    const deadline = createMemoryWorkDeadline(1000);
    let block: string | null;
    try {
      block = await buildMemoryContextBlock({ ...INPUT, deadline, respondByMs: Date.now() - 2000, callerWaiting: () => true });
    } finally {
      deadline.close();
    }
    await flush();
    expect(calls).toHaveLength(0);
    expect(block).toBe(off);
    const { admission } = recordRecallStatsMock.mock.calls.at(-1)![1] as { admission: { jev?: Record<string, unknown> } };
    expect(admission.jev).toMatchObject({ effective: 'on', skipped: 'no-time', callerWaiting: true });
    expect(admission.jev!.wallLeftMs as number).toBeLessThan(0);
    expect(admission.jev!.deadlineLeftMs as number).toBeGreaterThan(250);
  });
});
