import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Sql } from 'postgres';
import { readInsightsSnapshot, readMemoryHealth } from './knowledge-read';

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
  // readMemoryHealth issues three queries: the counts row, the recall-stats
  // aggregate (readRecallHealth), then the per-surface slice (P-006,
  // readRecallHealthBySurface). Respond per call.
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
