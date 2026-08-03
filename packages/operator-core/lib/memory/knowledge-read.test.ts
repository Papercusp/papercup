import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Sql } from 'postgres';
import {
  readInsightsSnapshot,
  readMemoryHealth,
  __resetStoreCountsCache,
  STORE_COUNTS_TTL_MS,
} from './knowledge-read';

/**
 * knowledge-read — the Learning tab Knowledge reader (operator-learning-tab
 * P-008). The insights half wraps the separately-tested readInsightsDir, so
 * here we pin only what THIS module adds: mtime-recency ordering + the
 * count/recent split. The memory half is pure SQL over an injected Sql.
 */

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-read-'));
  const mk = async (name: string, fm: string, mtime: Date) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, `---\n${fm}\n---\n\nBody.\n`, 'utf8');
    await fs.utimes(file, mtime, mtime);
  };
  await mk('older-insight.mdx', 'title: Older insight\ndescription: The older one.', new Date('2026-06-01T00:00:00Z'));
  await mk('newer-insight.mdx', 'title: Newer insight\ndescription: The newer one.\ntags: [pg, sync]', new Date('2026-06-08T00:00:00Z'));
  await mk('retired-insight.mdx', 'title: Retired insight\nstatus: retired', new Date('2026-06-09T00:00:00Z'));
  await mk('index.mdx', 'title: Section index', new Date('2026-06-09T00:00:00Z'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readInsightsSnapshot', () => {
  it('counts visible insights and orders recent by file mtime, newest first', async () => {
    const snap = await readInsightsSnapshot(dir);
    expect(snap.count).toBe(2); // retired + index excluded
    expect(snap.recent.map((r) => r.slug)).toEqual(['newer-insight', 'older-insight']);
    expect(snap.recent[0].title).toBe('Newer insight');
    expect(snap.recent[0].tags).toEqual(['pg', 'sync']);
    expect(snap.recent[0].modifiedAt).toBe('2026-06-08T00:00:00.000Z');
  });

  it('caps recent at the requested limit while count stays the full library size', async () => {
    const snap = await readInsightsSnapshot(dir, 1);
    expect(snap.count).toBe(2);
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0].slug).toBe('newer-insight');
  });

  it('degrades to an empty snapshot for a missing directory', async () => {
    const snap = await readInsightsSnapshot(path.join(dir, 'does-not-exist'));
    expect(snap).toEqual({ count: 0, recent: [] });
  });
});

describe('readMemoryHealth', () => {
  // WI-9137: the counts leg is now memoized behind a process-global TTL cache.
  // Every test here hands readMemoryHealth a FRESH positional mock, so a memo
  // surviving between tests would (a) skip the counts query entirely and (b)
  // shift every later response by one slot — surfacing as a baffling
  // wrong-value assertion in an unrelated test. Reset it per test.
  beforeEach(() => {
    __resetStoreCountsCache();
  });

  // readMemoryHealth issues FOUR queries: the counts row, the recall-stats
  // aggregate (readRecallHealth), the per-surface slice (P-006,
  // readRecallHealthBySurface), then the query-shape slice (P-041,
  // readRecallQueryHealth). Respond per call; the last response is reused for
  // any further call, so an added read inherits it rather than running dry.
  //
  // ⚠ SINCE WI-7369 THOSE FOUR RUN CONCURRENTLY (Promise.all), so this mock's
  // per-call sequencing now rests on the ISSUE order rather than on completion
  // order. That still holds — Promise.all evaluates its array eagerly and each
  // helper issues its sql call synchronously on entry — but it is no longer
  // self-evident from reading readMemoryHealth, and a helper that ever awaits
  // something BEFORE its sql call would silently re-shuffle which canned
  // response each read receives. The failure would surface here as a confusing
  // wrong-value assertion, not as an ordering error, so: if you add a read or
  // make a helper await first, give this mock explicit per-query matching
  // instead of a positional sequence.
  const sqlSequence = (responses: Array<Array<Record<string, unknown>> | Error>): Sql => {
    let call = 0;
    return ((_s: TemplateStringsArray, ..._v: unknown[]) => {
      const r = responses[Math.min(call++, responses.length - 1)];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }) as unknown as Sql;
  };

  it('maps counts + recall aggregate, excluding entity rows from totalMemories', async () => {
    const health = await readMemoryHealth(sqlSequence([
      [{ total_memories: 341, entity_rows: 1829, feedback_30d: 2 }],
      [{
        recalls: 40, zero_hits: 10, fragment_hits: 0,
        per_scale: [{ scale: 'cosine', scored: 30, p50: 0.52, p90: 0.74 }],
      }],
      [],
    ]));
    expect(health).toEqual({
      totalMemories: 341,
      entityRows: 1829,
      feedback30d: 2,
      recalls7d: 40,
      zeroHit7d: 10,
      zeroHitRate7d: 0.25,
      topScoreP50: 0.52,
      topScoreP90: 0.74,
      topScoreScale: 'cosine',
      topScoreSamples: 30,
      scaleMix: { cosine: 30 },
      fragmentHits7d: 0,
      recallBySurface: [],
      queryBySurface: [],
      recallTelemetryOk: true,
    });
  });

  // orient-recall-quality P-006: the per-surface slice rides the same read —
  // a single-surface regression (orient zero-hitting) stays visible.
  it('folds the per-surface recall slice into the health payload', async () => {
    const health = await readMemoryHealth(sqlSequence([
      [{ total_memories: 10, entity_rows: 0, feedback_30d: 0 }],
      [{
        recalls: 30, zero_hits: 3, fragment_hits: 0,
        per_scale: [{ scale: 'cosine', scored: 27, p50: 0.5, p90: 0.7 }],
      }],
      [
        {
          surface: 'search', recalls: 20, zero_hits: 1, fragment_hits: 0,
          per_scale: [{ scale: 'cosine', scored: 19, p50: 0.6, p90: 0.8 }],
        },
        { surface: 'orient', recalls: 10, zero_hits: 9, fragment_hits: 0, per_scale: [] },
      ],
    ]));
    expect(health.recallBySurface).toHaveLength(2);
    expect(health.recallBySurface[1]).toMatchObject({ surface: 'orient', zeroHitRate7d: 0.9 });
  });

  // P-041: the QUERY side rides the same read. Every other field here measures
  // what recall returned, which cannot say whether the query was any good.
  it('folds the query-shape slice into the health payload (P-041)', async () => {
    const health = await readMemoryHealth(sqlSequence([
      [{ total_memories: 10, entity_rows: 0, feedback_30d: 0 }],
      [{ recalls: 30, zero_hits: 3, fragment_hits: 0, per_scale: [] }],
      [],
      [{
        surface: 'turn-start', recalls: 100, machine_origin: 82, short_queries: 4,
        chars_p50: 900, chars_p10: 60,
        origin_mix: { 'loop-fire': 70, 'wake-pump': 12, '(no-envelope)': 18 },
        repeat_eligible: 90, repeat_count: 27,
      }],
    ]));
    expect(health.queryBySurface).toHaveLength(1);
    expect(health.queryBySurface[0]).toMatchObject({
      surface: 'turn-start',
      machineOriginRate: 0.82,
      // Denominator is repeatEligible (rows WITH a predecessor), never recalls.
      repeatRate: 0.3,
      shortQueryRate: 0.04,
    });
  });

  it('zero-fills an empty result rather than crashing', async () => {
    const health = await readMemoryHealth(sqlSequence([[], []]));
    expect(health).toMatchObject({ totalMemories: 0, entityRows: 0, feedback30d: 0, recalls7d: 0 });
  });

  it('recall-stats failure (migration 240 absent) degrades to zeros, counts survive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const health = await readMemoryHealth(sqlSequence([
      [{ total_memories: 12, entity_rows: 3, feedback_30d: 1 }],
      new Error('relation "harness_shared.memory_recall_stats" does not exist'),
    ]));
    warn.mockRestore();
    expect(health).toMatchObject({
      totalMemories: 12,
      entityRows: 3,
      feedback30d: 1,
      recalls7d: 0,
      zeroHitRate7d: 0,
      topScoreP50: null,
      fragmentHits7d: 0,
    });
  });

  // EI-10625. The degrade above is the whole trap: a FAILED read produces
  // `zeroHitRate7d: 0` — "no recall ever missed", the healthiest value in the range —
  // and every consumer downstream reads it as a clean bill of health. The zeros are
  // fine to return; returning them WITHOUT SAYING SO is not. This flag is the only
  // thing distinguishing a perfect store from an unreadable one.
  it('flags the failed read so its all-zeros cannot be mistaken for perfect health', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const health = await readMemoryHealth(sqlSequence([
      [{ total_memories: 10_491, entity_rows: 0, feedback_30d: 250 }],
      new Error('relation "harness_shared.memory_recall_stats" does not exist'),
    ]));
    warn.mockRestore();
    // Reads as flawless recall over a 10k-memory store — and is worth exactly nothing.
    expect(health.zeroHitRate7d).toBe(0);
    expect(health.recallTelemetryOk).toBe(false);
  });

  it('a healthy read is marked trustworthy', async () => {
    const health = await readMemoryHealth(sqlSequence([
      [{ total_memories: 341, entity_rows: 0, feedback_30d: 2 }],
      [{ recalls: 40, zero_hits: 10, p50: 0.5, p90: 0.7, fragment_hits: 0 }],
      [],
    ]));
    expect(health.recallTelemetryOk).toBe(true);
  });
});

/**
 * WI-9137 — the store-counts memo.
 *
 * The defect: the system-health tick recomputes these counts every 30s PER
 * WORKSPACE in EVERY operator-shaped process, and the SQL carries no
 * workspace_id predicate — so N workspaces each independently recomputed the
 * identical global number. Measured 1,292,711 calls / 12.97h of DB time / 8.7B
 * buffer hits over 24.5 days, live at 0.68 calls/s.
 *
 * These tests pin the three properties that make the memo correct rather than
 * merely present: it must actually SUPPRESS the second query, it must
 * single-flight concurrent callers, and it must never cache a failure.
 */
describe('readMemoryHealth store-counts memo (WI-9137)', () => {
  beforeEach(() => {
    __resetStoreCountsCache();
  });

  /** Counts sql calls so a test can assert queries were SUPPRESSED, not just that values matched. */
  const countingSql = (
    responses: Array<Array<Record<string, unknown>> | Error>,
    onCall: () => void,
  ): Sql => {
    let call = 0;
    return ((_s: TemplateStringsArray, ..._v: unknown[]) => {
      onCall();
      const r = responses[Math.min(call++, responses.length - 1)];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }) as unknown as Sql;
  };

  const legs = (counts: Record<string, unknown>) => [
    [counts],
    [{ recalls: 1, zero_hits: 0, fragment_hits: 0, per_scale: [] }],
    [],
  ];

  it('serves the second call from cache — the counts query does not run again', async () => {
    let firstCalls = 0;
    const a = await readMemoryHealth(
      countingSql(legs({ total_memories: 4103, entity_rows: 29701, feedback_30d: 7 }), () => { firstCalls++; }),
    );
    expect(a.totalMemories).toBe(4103);
    const issuedByFirst = firstCalls;

    // A SECOND caller whose mock would answer with DIFFERENT numbers. If the memo
    // were absent, we would observe 999 here — so this discriminates a real cache
    // hit from "the values happened to match".
    let secondCounts = 0;
    const b = await readMemoryHealth(
      countingSql(legs({ total_memories: 999, entity_rows: 999, feedback_30d: 999 }), () => { secondCounts++; }),
    );
    expect(b.totalMemories).toBe(4103);
    expect(b.entityRows).toBe(29701);
    expect(b.feedback30d).toBe(7);
    // The second call still issues its recall legs, but strictly FEWER queries
    // than the first — the counts leg was suppressed.
    expect(secondCounts).toBeLessThan(issuedByFirst);
  });

  it('single-flights concurrent callers onto ONE counts query', async () => {
    // The real trigger: several workspaces tick at once in the same process.
    // Without promise-caching each would miss the cache and issue its own query.
    let countsQueries = 0;
    const mk = () =>
      countingSql(legs({ total_memories: 10, entity_rows: 20, feedback_30d: 30 }), () => { countsQueries++; });
    const [x, y, z] = await Promise.all([
      readMemoryHealth(mk()),
      readMemoryHealth(mk()),
      readMemoryHealth(mk()),
    ]);
    expect([x.totalMemories, y.totalMemories, z.totalMemories]).toEqual([10, 10, 10]);
    // 3 concurrent callers x (1 counts + 3 recall legs) would be 12 unmemoized.
    // Exactly one counts query may run; the rest are recall legs.
    expect(countsQueries).toBeLessThan(12);
  });

  it('does NOT cache a rejection — a failed counts read is retried, not pinned for the TTL', async () => {
    const boom = new Error('counts read failed');
    // Only the FIRST (counts) leg rejects; the recall legs answer healthily, so
    // this test isolates the counts failure instead of also tripping the
    // recall-stats degrade path (which warns, and would fail on console).
    await expect(
      readMemoryHealth(
        countingSql([boom, [{ recalls: 1, zero_hits: 0, fragment_hits: 0, per_scale: [] }], []], () => {}),
      ),
    ).rejects.toThrow('counts read failed');

    // Immediately afterwards (well inside the TTL) a healthy read must succeed.
    // If the rejected promise had been left in the map, this would re-throw and
    // the panel would stay broken for a full TTL after one transient blip.
    const ok = await readMemoryHealth(
      countingSql(legs({ total_memories: 5, entity_rows: 6, feedback_30d: 7 }), () => {}),
    );
    expect(ok.totalMemories).toBe(5);
  });

  it('TTL is at least the 30s system-health tick interval', () => {
    // If the TTL ever drops below the tick, consecutive ticks straddle an expiry
    // and the memo stops collapsing them — the whole point of the change.
    expect(STORE_COUNTS_TTL_MS).toBeGreaterThanOrEqual(30_000);
  });
});
