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
import { ISSUE_SHIPPED_STATUSES } from '../work-item-blocking';

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

/** An idea whose routed artifact REACHED an outcome — a resolved/closed work
 *  item or an adopted (non-draft) plan. The idea→work→done chain, banked
 *  (owner ask 2026-07-19: idea-derived shipped outcomes must be visible in
 *  Retain, not just implied by lens weights). */
export interface RetainShippedIdea {
  ideaId: string;
  title: string | null;
  rail: string;
  routedRef: string;
  /** The raw end state: engineer_issues.state (the unified work-item enum) or
   *  the routed plan's lifecycle status. Shown verbatim as the outcome chip. */
  outcome: string;
  /**
   * Did it LAND, as opposed to merely reaching an end state? Classified HERE,
   * on the server, against the shared ISSUE_SHIPPED_STATUSES — deliberately not
   * left to the client.
   *
   * The client cannot value-import the shared set (work-item-blocking pulls the
   * pg layer, which must not enter the browser bundle), so it previously
   * re-typed the member list by hand — and drifted: its list still named the
   * pre-unify `resolved`/`closed`, so a `done` item rendered as NOT-good while
   * an abandoned `closed`/`dropped` one rendered as a win. Stamping the verdict
   * server-side removes the second copy rather than fixing it twice
   * (EI-18792873324746237).
   */
  shipped: boolean;
  completedAt: string | null;
}

/** A plan the Blender/scout GENERATED: a rail='plan' routed idea joined to the
 *  plan row it produced (D-004, blender-loop-repair-and-opus5-xhigh-2026-08-16:
 *  Retain lists the loop's generated plans the way its other generated
 *  artifacts are surfaced — a read over the existing plan store, nothing new
 *  written). Routed refs whose plan is MISSING from the store are a structural
 *  gap tracked under that plan's P-005, deliberately absent here (inner join). */
export interface RetainBlenderPlan {
  planSlug: string;
  /** harness_plans.title, falling back to the slug when unset. */
  title: string;
  /** harness_plans.status verbatim (draft/ready/active/shipped/superseded); '' when unset. */
  status: string;
  /** When the scout routed the idea into the plan store (timestamptz text). */
  routedAt: string | null;
  ideaId: string;
  ideaTitle: string | null;
  lens: string;
}

export interface RetainExtrasSnapshot {
  banked: RetainBankedCounts;
  /** Idea-derived artifacts that reached an outcome, newest first. */
  shippedFromIdeas: RetainShippedIdea[];
  /** Blender-generated plans (rail='plan' routed refs resolved in the plan store), newest routed first. */
  blenderPlans: RetainBlenderPlan[];
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

  // Idea-derived outcomes (owner ask 2026-07-19): routed ideas whose artifact
  // REACHED an end state — wi: refs resolved/closed, plan: refs past draft.
  // Workspace-scoped joins (multi-tenant tables); newest outcome first.
  let shippedFromIdeas: RetainShippedIdea[] = [];
  try {
    const rows = (await sql`
      SELECT DISTINCT ON (r.idea_id)
             r.idea_id, r.title, r.rail, r.routed_ref,
             COALESCE(ei.state, hp.status) AS outcome,
             COALESCE(ei.updated_at, hp.updated_at)::text AS completed_at
        FROM harness_shared.scout_routed_ideas r
        LEFT JOIN harness_shared.engineer_issues ei
          ON ei.workspace_id = r.workspace_id
         AND r.routed_ref LIKE 'wi:%'
         AND ei.issue_id = substring(r.routed_ref from 4)
        LEFT JOIN harness_shared.harness_plans hp
          ON hp.workspace_id = r.workspace_id
         AND r.routed_ref LIKE 'plan:%'
         AND hp.plan_slug = substring(r.routed_ref from 6)
       WHERE r.workspace_id = ${workspaceId}
         AND (
           -- EI-18792873324746237: this filtered the pre-unify spellings only,
           -- so after the writer-flip NO work-item-routed idea could ever reach
           -- this list — all 137 shipped ones were silently excluded and only
           -- the plan-routed branch below produced rows. Bind the shared set.
           ei.state = ANY(${[...ISSUE_SHIPPED_STATUSES]}::text[])
           OR (hp.status IS NOT NULL AND hp.status NOT IN ('draft', 'superseded'))
         )
       ORDER BY r.idea_id, COALESCE(ei.updated_at, hp.updated_at) DESC NULLS LAST
    `) as Array<Record<string, unknown>>;
    shippedFromIdeas = rows
      .map((r) => {
        const outcome = String(r.outcome ?? '');
        return {
          ideaId: String(r.idea_id ?? ''),
          title: typeof r.title === 'string' && r.title ? r.title : null,
          rail: String(r.rail ?? ''),
          routedRef: String(r.routed_ref ?? ''),
          outcome,
          // The two rails end in DIFFERENT vocabularies, so classify per rail:
          // a work item lands at done|resolved; a plan lands only at 'shipped'
          // ('ready'/'active' also survive the WHERE clause above, but they are
          // in-progress, not delivered, and must not read as wins).
          shipped: ISSUE_SHIPPED_STATUSES.has(outcome) || outcome === 'shipped',
          completedAt: typeof r.completed_at === 'string' ? r.completed_at : null,
        };
      })
      .filter((r) => r.ideaId)
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
      .slice(0, SECTION_CAP);
  } catch (err) {
    console.warn('[learning.retain] shipped-from-ideas read failed:', err instanceof Error ? err.message : err);
  }

  // Blender-generated plans (D-004 / P-012): plan-rail routed refs joined to
  // the plan store — Retain lists what the ideation loop DRAFTED, not only what
  // shipped. DISTINCT ON keeps the newest routing when an idea was re-routed to
  // the same plan; refs whose plan is missing are excluded by the inner join
  // (that structural gap is P-005's, not this view's).
  let blenderPlans: RetainBlenderPlan[] = [];
  try {
    const rows = (await sql`
      SELECT DISTINCT ON (hp.plan_slug)
             hp.plan_slug,
             COALESCE(hp.title, hp.plan_slug) AS title,
             COALESCE(hp.status, '') AS status,
             to_timestamp(r.routed_at / 1000.0)::text AS routed_at,
             r.idea_id, r.title AS idea_title, r.lens
        FROM harness_shared.scout_routed_ideas r
        JOIN harness_shared.harness_plans hp
          ON hp.workspace_id = r.workspace_id
         AND hp.plan_slug = substring(r.routed_ref from 6)
       WHERE r.workspace_id = ${workspaceId}
         AND r.rail = 'plan'
         AND r.routed_ref LIKE 'plan:%'
       ORDER BY hp.plan_slug, r.routed_at DESC
    `) as Array<Record<string, unknown>>;
    blenderPlans = rows
      .map((r) => ({
        planSlug: String(r.plan_slug ?? ''),
        title: String(r.title ?? ''),
        status: String(r.status ?? ''),
        routedAt: typeof r.routed_at === 'string' ? r.routed_at : null,
        ideaId: String(r.idea_id ?? ''),
        ideaTitle: typeof r.idea_title === 'string' && r.idea_title ? r.idea_title : null,
        lens: String(r.lens ?? ''),
      }))
      .filter((p) => p.planSlug)
      .sort((a, b) => (b.routedAt ?? '').localeCompare(a.routedAt ?? ''))
      .slice(0, SECTION_CAP);
  } catch (err) {
    console.warn('[learning.retain] blender-plans read failed:', err instanceof Error ? err.message : err);
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
    shippedFromIdeas,
    blenderPlans,
    lensWeights,
    rubricChanges,
    insightDocs,
    recipes,
    generatedAt,
  };
}
