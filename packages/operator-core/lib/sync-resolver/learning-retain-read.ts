/**
 * learning-retain-read.ts — the read behind the Retain view's "everything else
 * the colony keeps" sections (WI-5412, owner ask 2026-07-18: the view showed
 * only the memory pool + pack candidates while lens weights, rubric changes,
 * agent-insight docs, and recipes — all retained learning — were invisible).
 *
 * One snapshot, five best-effort legs (each degrades independently — the
 * Retain view must never 500 because one store hiccuped):
 *
 *   1. **banked** — the "what stuck this week" strip counts: improvements
 *      filed + plans drafted in the trailing 7 days (the retained-learnings
 *      count itself comes from the `learning.hive` rows the view already has).
 *   2. **lensWeights** — the ideator's persisted per-lens sampling weights
 *      (the loop learns which creative lenses win and biases future cycles).
 *   3. **rubricChanges** — most-recently-updated rubrics (amendments patch the
 *      stored rubric in place, so recency of update IS the amendment signal).
 *   4. **insightDocs** — newest agent-insight runbooks by their `discovered`
 *      frontmatter date (fs read over the Starlight content tree).
 *   5. **recipes** — the most-recently-run code recipes.
 *
 * Pure over injected deps (mirrors learning-hive-read) so the resolver test
 * stubs every seam.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';

export interface RetainBankedCounts {
  /** engineer_issues improvements filed in the trailing 7d (hive-scoped when scopes given). null = leg degraded. */
  improvementsFiled7d: number | null;
  /** harness_plans rows created in the trailing 7d (hive-scoped when member slugs given). null = leg degraded. */
  plansDrafted7d: number | null;
}

export interface RetainRubricChange {
  slug: string;
  title: string;
  status: string;
  updatedAt: string;
}

export interface RetainInsightDoc {
  slug: string;
  title: string;
  /** The doc's `discovered:` frontmatter date (YYYY-MM-DD), when present. */
  discovered: string | null;
}

export interface RetainRecipe {
  id: string;
  title: string;
  runCount: number;
  lastRunAt: string | null;
}

export interface RetainExtrasSnapshot {
  banked: RetainBankedCounts;
  /** null when none recorded yet (or the read degraded). */
  lensWeights: Record<string, number> | null;
  rubricChanges: RetainRubricChange[];
  insightDocs: RetainInsightDoc[];
  recipes: RetainRecipe[];
  generatedAt: string;
}

export interface RetainExtrasOpts {
  /** Hive member-harness SCOPES (`harness:<slug>` …) for the improvements count;
   *  omit for the workspace-wide count. Empty array counts nothing (a hive with
   *  no member harnesses has no filings of its own). */
  harnessScopes?: readonly string[];
  /** Bare member-harness slugs for the plans count; omit for workspace-wide. */
  memberSlugs?: readonly string[];
}

export interface RetainExtrasDeps {
  listRubrics: () => Promise<Array<{ slug: string; title: string; status: string; updatedAt: string }>>;
  listRecipes: () => Promise<Array<{ id: string; title: string; runCount: number; lastRunAt: string | null }>>;
  readLensWeights: () => Promise<Record<string, number>>;
  readInsightDocs: () => Promise<RetainInsightDoc[]>;
}

const SECTION_CAP = 8;

/** Parse `title:` + `discovered:` out of an .mdx frontmatter block (regex — the
 *  files are our own generated runbooks, never arbitrary input). */
export function parseInsightFrontmatter(slug: string, text: string): RetainInsightDoc {
  const head = text.slice(0, 2000);
  const title = /^title:\s*(?:["']?)(.+?)(?:["']?)\s*$/m.exec(head)?.[1]?.trim();
  const discovered = /^discovered:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(head)?.[1] ?? null;
  return { slug, title: title || slug, discovered };
}

/**
 * Newest agent-insight docs from the Starlight content tree. mtime prefilters
 * (one readdir + parallel stats), then only the newest few files are opened for
 * their frontmatter — never a serial read over the whole 500+ doc corpus (A1).
 */
export async function readRecentInsightDocs(contentDir: string, cap = SECTION_CAP): Promise<RetainInsightDoc[]> {
  const names = (await fs.readdir(contentDir)).filter((n) => /\.(md|mdx)$/.test(n));
  const stats = await Promise.all(
    names.map(async (n) => {
      try {
        const st = await fs.stat(path.join(contentDir, n));
        return { name: n, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const newest = stats
    .filter((s): s is { name: string; mtimeMs: number } => s !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, cap * 3);
  const docs = await Promise.all(
    newest.map(async ({ name }) => {
      try {
        const text = await fs.readFile(path.join(contentDir, name), 'utf8');
        return parseInsightFrontmatter(name.replace(/\.(md|mdx)$/, ''), text);
      } catch {
        return null;
      }
    }),
  );
  return docs
    .filter((d): d is RetainInsightDoc => d !== null)
    .sort((a, b) => (b.discovered ?? '').localeCompare(a.discovered ?? ''))
    .slice(0, cap);
}

export async function readRetainExtras(
  sql: Sql,
  workspaceId: string,
  deps: RetainExtrasDeps,
  opts: RetainExtrasOpts = {},
): Promise<RetainExtrasSnapshot> {
  const generatedAt = new Date().toISOString();

  let improvementsFiled7d: number | null = null;
  try {
    const rows = (await sql`
      SELECT count(*)::int AS n
        FROM harness_shared.engineer_issues ei
       WHERE ei.workspace_id = ${workspaceId}
         AND ei.created_at > now() - interval '7 days'
         AND ${opts.harnessScopes ? sql`ei.scope = ANY(${opts.harnessScopes as string[]}::text[])` : sql`TRUE`}
         AND EXISTS (
           SELECT 1 FROM harness_shared.coord_links cl
            WHERE cl.workspace_id = ${workspaceId}
              AND cl.rel = 'tagged'
              AND cl.src_ref = ei.issue_id
              AND cl.dst_kind = 'topic'
              AND cl.dst_ref = 'papercusp-improvement'
         )
    `) as Array<{ n: number }>;
    improvementsFiled7d = Number(rows[0]?.n ?? 0);
  } catch (err) {
    console.warn('[learning.retain] improvements-count read failed:', err instanceof Error ? err.message : err);
  }

  let plansDrafted7d: number | null = null;
  try {
    const rows = (await sql`
      SELECT count(*)::int AS n
        FROM harness_shared.harness_plans hp
       WHERE hp.workspace_id = ${workspaceId}
         AND hp.created > now() - interval '7 days'
         AND ${opts.memberSlugs ? sql`hp.harness_slug = ANY(${opts.memberSlugs as string[]}::text[])` : sql`TRUE`}
    `) as Array<{ n: number }>;
    plansDrafted7d = Number(rows[0]?.n ?? 0);
  } catch (err) {
    console.warn('[learning.retain] plans-count read failed:', err instanceof Error ? err.message : err);
  }

  let lensWeights: Record<string, number> | null = null;
  try {
    const weights = await deps.readLensWeights();
    lensWeights = Object.keys(weights).length > 0 ? weights : null;
  } catch (err) {
    console.warn('[learning.retain] lens-weight read failed:', err instanceof Error ? err.message : err);
  }

  let rubricChanges: RetainRubricChange[] = [];
  try {
    rubricChanges = (await deps.listRubrics())
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, SECTION_CAP)
      .map((r) => ({ slug: r.slug, title: r.title, status: r.status, updatedAt: r.updatedAt }));
  } catch (err) {
    console.warn('[learning.retain] rubric read failed:', err instanceof Error ? err.message : err);
  }

  let insightDocs: RetainInsightDoc[] = [];
  try {
    insightDocs = await deps.readInsightDocs();
  } catch (err) {
    console.warn('[learning.retain] insight-doc read failed:', err instanceof Error ? err.message : err);
  }

  let recipes: RetainRecipe[] = [];
  try {
    recipes = (await deps.listRecipes())
      .slice(0, SECTION_CAP)
      .map((r) => ({ id: r.id, title: r.title, runCount: r.runCount, lastRunAt: r.lastRunAt }));
  } catch (err) {
    console.warn('[learning.retain] recipes read failed:', err instanceof Error ? err.message : err);
  }

  return {
    banked: { improvementsFiled7d, plansDrafted7d },
    lensWeights,
    rubricChanges,
    insightDocs,
    recipes,
    generatedAt,
  };
}
