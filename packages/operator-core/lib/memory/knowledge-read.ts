/**
 * knowledge-read.ts — the reads behind the Learning tab's "Knowledge" sub-view
 * (operator-learning-tab-2026-06-09 P-008 / learning-system-audit P-042).
 *
 * Two halves, both consumed by the `learning.knowledge` sync resolver:
 *
 *  1. **Insights snapshot** — count + the most-recently-touched runbooks from
 *     the agent-insights MDX library. Wraps the existing {@link readInsightsDir}
 *     reader (single source of truth with the session-start prelude) rather than
 *     re-parsing frontmatter; "recent" is file mtime because the frontmatter
 *     carries no date field. The Learning tab shows the recent five as a teaser
 *     and cross-links to the full Insights tab — it does NOT duplicate that tab.
 *
 *  2. **Memory health** — total canonical memories + feedback events in the last
 *     30 days. The old D-005 "memory unpopulated" exclusion is stale (the store
 *     has real rows now); a zero `feedback30d` against a populated store is
 *     exactly the signal P-050 ("turn the feedback loop on") needs the owner to
 *     see. Pure SQL over an injected `Sql` (mirrors iq-battery/benchmark-read);
 *     the caller supplies the org-PG handle so this module stays seam-testable.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Sql } from 'postgres';
import { readInsightsDir, type InsightEntry } from './insights-index';
import { readRecallHealth, type RecallHealth } from './recall-stats';
import type { MemoryPrecisionSnapshot } from './bench/precision-read';
import { DOCS_CONTENT_ROOT } from '../agent-tools/docs/_repo-paths';

/** Canonical agent-insights MDX directory (the same tree docs:* serves). */
export const INSIGHTS_DIR = path.join(DOCS_CONTENT_ROOT, 'agent-insights');

export interface RecentInsight extends InsightEntry {
  /** ISO mtime of the .mdx file — the "recent" ordering proxy (frontmatter has no date). */
  modifiedAt: string | null;
}

export interface InsightsSnapshot {
  /** Visible (non-retired/superseded) runbooks in the library. */
  count: number;
  /** The newest few by file mtime, newest first. */
  recent: RecentInsight[];
}

/**
 * Count + recent-N over the insights library. Missing dir / unreadable files
 * degrade to an empty snapshot (readInsightsDir already swallows ENOENT).
 */
export async function readInsightsSnapshot(
  dir: string = INSIGHTS_DIR,
  recentLimit = 5,
): Promise<InsightsSnapshot> {
  const entries = await readInsightsDir(dir);
  const withMtime: RecentInsight[] = await Promise.all(
    entries.map(async (e) => {
      try {
        const st = await fs.stat(path.join(dir, `${e.slug}.mdx`));
        return { ...e, modifiedAt: st.mtime.toISOString() };
      } catch {
        return { ...e, modifiedAt: null };
      }
    }),
  );
  withMtime.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  return { count: entries.length, recent: withMtime.slice(0, Math.max(0, recentLimit)) };
}

export interface MemoryHealth extends RecallHealth {
  /**
   * REAL memories in harness_shared.memory_canonical. Excludes mem0's
   * entity-store rows (payload ? 'entityType'), which share the physical
   * table — pre-EI-366 this counted them too and read 2,170 when the
   * store held 341 actual facts.
   */
  totalMemories: number;
  /** Segregated mem0 entity-linking rows sharing the canonical table. */
  entityRows: number;
  /** memory_feedback events in the trailing 30 days — the loop's pulse. */
  feedback30d: number;
  /**
   * The memory-precision-bench trend (relight P-033) — latest FP@5 / R@10 /
   * precision + a short history. Populated by the `learning.knowledge` resolver
   * (it needs the workspace id `readMemoryHealth` doesn't take); `null`/absent
   * when the bench has never run or migration 312 isn't applied yet.
   */
  precision?: MemoryPrecisionSnapshot | null;
}

/**
 * Health read over the canonical memory tables + recall telemetry.
 * The recall aggregate degrades to zeros independently (e.g. migration
 * 240 not applied yet) so the store counts never vanish with it.
 */
export async function readMemoryHealth(sql: Sql): Promise<MemoryHealth> {
  const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM harness_shared.memory_canonical
        WHERE NOT (payload ? 'entityType'))                       AS total_memories,
      (SELECT count(*)::int FROM harness_shared.memory_canonical
        WHERE payload ? 'entityType')                             AS entity_rows,
      (SELECT count(*)::int FROM harness_shared.memory_feedback
        WHERE created_at >= now() - interval '30 days')           AS feedback_30d
  `) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  let recall: RecallHealth = {
    recalls7d: 0,
    zeroHit7d: 0,
    zeroHitRate7d: 0,
    topScoreP50: null,
    topScoreP90: null,
    fragmentHits7d: 0,
  };
  try {
    recall = await readRecallHealth(sql);
  } catch (err) {
    console.warn('[memory-health] recall-stats read failed (migration 240 applied?):', (err as Error).message);
  }
  return {
    ...recall,
    totalMemories: Number(r.total_memories ?? 0),
    entityRows: Number(r.entity_rows ?? 0),
    feedback30d: Number(r.feedback_30d ?? 0),
  };
}
