/**
 * learning-retain-read.ts — the reads behind the Retain view.
 *
 * Two surfaces (Variant D, WI-39493 — owner pick 2026-08-16, replacing the
 * WI-5412-era per-store disclosure sections):
 *
 *   1. **readRetainExtras** — the slim always-on strip data: the banked-this-week
 *      counts + the ideator's lens weights (the one retained artifact that is a
 *      DISTRIBUTION, not a feed — it gets its own strip card, never a ledger row).
 *   2. **readRetainFeed** — the unified "Retained" ledger: plans, idea-routed
 *      work items, rubrics, insight runbooks, and code recipes as ONE
 *      recency-interleaved feed with a composite keyset cursor
 *      (ts DESC, kind ASC, id ASC) and per-kind tab/shipped filters. The
 *      interleave is load-bearing, not cosmetic: code_recipes holds ~13.5k rows,
 *      so corpus order would bury every other kind.
 *   3. **readRetainPlanChildren** — the plan-born work items behind one plan
 *      row's expand chevron (engineer_issues.source_plan_slug).
 *
 * Every leg degrades independently (the view must never 500 because one store
 *  hiccuped); a failed leg lands in `degraded` instead of throwing.
 * Pure over injected deps (mirrors learning-hive-read) so the resolver test
 * stubs every seam.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';
import { ISSUE_ABANDONED_STATUSES, ISSUE_SHIPPED_STATUSES } from '../work-item-blocking';
import { createReadDeadline, type WithinBudget } from './read-deadline';
import {
  compareRetainRows,
  decodeRetainCursor,
  encodeRetainCursor,
  inRetainLegWindow,
  retainLegWindowFor,
  RETAIN_DETAIL_BODY_MAX,
  RETAIN_KIND_FOR_TAB,
  type RetainDetail,
  type RetainFeedCounts,
  type RetainFeedCursor,
  type RetainFeedFilter,
  type RetainFeedKind,
  type RetainFeedPage,
  type RetainFeedRow,
  type RetainFeedTab,
  type RetainLegWindow,
  type RetainPlanChild,
} from './learning-retain-types';

export type {
  RetainDetail,
  RetainFeedCounts,
  RetainFeedCursor,
  RetainFeedFilter,
  RetainFeedKind,
  RetainFeedPage,
  RetainFeedRow,
  RetainFeedTab,
  RetainPlanChild,
} from './learning-retain-types';
export { decodeRetainCursor, encodeRetainCursor, RETAIN_DETAIL_BODY_MAX } from './learning-retain-types';

export interface RetainBankedCounts {
  /** engineer_issues improvements filed in the trailing 7d (hive-scoped when scopes given). null = leg degraded. */
  improvementsFiled7d: number | null;
  /** harness_plans rows created in the trailing 7d (hive-scoped when member slugs given). null = leg degraded. */
  plansDrafted7d: number | null;
}

export interface RetainExtrasSnapshot {
  banked: RetainBankedCounts;
  /** null when none recorded yet (or the read degraded). */
  lensWeights: Record<string, number> | null;
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
  readLensWeights: () => Promise<Record<string, number>>;
}

/** Parse `title:` + `discovered:` out of an .mdx frontmatter block (regex — the
 *  files are our own generated runbooks, never arbitrary input). */
export function parseInsightFrontmatter(
  slug: string,
  text: string,
): { slug: string; title: string; discovered: string | null } {
  const head = text.slice(0, 2000);
  const title = /^title:\s*(?:["']?)(.+?)(?:["']?)\s*$/m.exec(head)?.[1]?.trim();
  const discovered = /^discovered:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(head)?.[1] ?? null;
  return { slug, title: title || slug, discovered };
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

  return { banked: { improvementsFiled7d, plansDrafted7d }, lensWeights, generatedAt };
}

// ─── The unified Retained feed ───────────────────────────────────────────────

/**
 * First-page size for the Retained ledger.
 *
 * Raised 24 → 75 for WI-39675 (plan learning-tab-filters-are-page-scoped-2026-08-17).
 * D-002 requires a FRESH payload measurement for any page-size raise, not an
 * appeal to the decision itself. Measured 2026-08-17 against :3170, warm, three
 * samples each (`/api/zero-harness/rest-query?name=learning.retainFeed`,
 * tab=all filter=all hive=papercusp):
 *
 *   limit=24  → 8,861 B   ~0.61s
 *   limit=50  → 21,582 B  ~0.67s
 *   limit=75  → 31,186 B  ~0.73s   ← the knee: 3.1x the rows for +20% latency
 *   limit=100 → 45,830 B  ~1.02s   (+67% latency for 4.2x the rows)
 *
 * 31 KB is ~12% of the 250,000 B payload budget D-002 cites for
 * learning.observations, so bytes are nowhere near the binding constraint here —
 * LATENCY is, because all five legs each fetch `limit` rows before the k-way
 * merge discards all but `limit` of them. 75 keeps the MAX_PAGE clamp a real
 * ceiling rather than collapsing the default onto it.
 */
export const RETAIN_FEED_PAGE_SIZE = 75;
const RETAIN_FEED_MAX_PAGE = 100;

/** ISO-normalize a driver value (Date from a raw timestamptz select, string
 *  from a ::text cast or a test stub). Feed timestamps are ms precision on both
 *  the SQL side (date_trunc('milliseconds', …)) and here, so cursor equality
 *  compares like with like. */
function toIsoMs(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/** One shared-memory entry as the memory leg consumes it — structurally a
 *  subset of the memory backend's MemoryEntry, so `backend.list()` results pass
 *  straight through. Timestamps ride in `metadata` (mem0 stamps
 *  updated_at/created_at into the payload); {@link retainMemoryTsOf} extracts
 *  them. */
export interface RetainMemorySource {
  id: string;
  text: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

/** Recency instant of a shared-memory entry: updated beats created; a row with
 *  neither reads as epoch so it stays VISIBLE at the ledger's tail instead of
 *  silently vanishing from an editable store. */
export function retainMemoryTsOf(metadata: Record<string, unknown> | undefined): string {
  for (const key of ['updated_at', 'updatedAt', 'created_at', 'createdAt'] as const) {
    const iso = toIsoMs(metadata?.[key]);
    if (iso) return iso;
  }
  return '1970-01-01T00:00:00.000Z';
}

/** Ledger row title for a memory: the fact itself, whitespace-collapsed and
 *  clamped — the FULL text is the detail read's job (WI-39534). */
export function retainMemoryTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 200 ? `${normalized.slice(0, 199).trimEnd()}…` : normalized;
}

export interface RetainFeedDeps {
  /** The hive's shared-memory pool (WI-39535), already scope-resolved by the
   *  caller (`hive:<slug>` / every pot under the All-Pots lens). A throw
   *  degrades the leg like any other. */
  listMemories: () => Promise<RetainMemorySource[]>;
  /** Optional bounded/keyset read over the SAME memory corpus. Canonical-
   *  backed callers expose this so a 75-row ledger page never materializes the
   *  whole store; pluggable backends without it retain `listMemories` exactly. */
  listMemoriesPage?: (opts: {
    window: RetainLegWindow | null;
    limit: number;
  }) => Promise<RetainMemorySource[]>;
  /** Optional exact corpus count over the SAME memory scopes. This is separate
   *  from the bounded page on purpose: a page length is never a badge total. */
  countMemories?: () => Promise<number>;
  listRubrics: () => Promise<Array<{ slug: string; title: string; status: string; updatedAt: string }>>;
  /** One keyset page of recipes by recent activity (code-recipes-store
   *  listRecipesActivityPage). `ts` = GREATEST(last_run_at, updated_at, created_at). */
  listRecipesPage: (opts: {
    window: RetainLegWindow | null;
    limit: number;
  }) => Promise<Array<{ id: string; title: string; runCount: number; ts: string }>>;
  countRecipes: () => Promise<number>;
  /** One keyset page of agent-insight runbooks by file mtime (readInsightDocsPage). */
  listRunbooksPage: (opts: {
    window: RetainLegWindow | null;
    limit: number;
  }) => Promise<Array<{ slug: string; title: string; discovered: string | null; ts: string }>>;
  countRunbooks: () => Promise<number>;
}

export interface RetainFeedOpts {
  tab?: RetainFeedTab;
  filter?: RetainFeedFilter;
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor?: string | null;
  limit?: number;
  /** P-040 hive lens (same semantics as {@link RetainExtrasOpts}): scopes the
   *  wi leg by `engineer_issues.scope`. Omit for workspace-wide. The rubric /
   *  runbook / recipe corpora are lens-invariant and never scoped. */
  harnessScopes?: readonly string[];
  /** Hive-member harness slugs; scopes the plans leg by `hp.harness_slug`. */
  memberSlugs?: readonly string[];
  /** Whole-read deadline override in ms (default {@link RETAIN_READ_BUDGET_MS}).
   *  SERVER-SET ONLY: the resolver builds this opts object field by field and
   *  never spreads client args, so a caller cannot widen it into a DoS knob.
   *  Tests pass a tiny value to exercise the degrade path without waiting. */
  budgetMs?: number;
  /**
   * Compute the tab-badge corpus counts inline on the first page.
   *
   * DEFAULTS TO FALSE, and the `learning.retainFeed` resolver never opts in —
   * counts are their own read now (`readRetainCounts` / `learning.retainCounts`,
   * WI-39900). Inline they cost 4.79s of a 4.81s Runbooks page and held every
   * tab's rows hostage to the memory backend's ~10.9s p50. Opting back in is
   * for tests and for a caller that genuinely wants one round-trip and has
   * accepted that latency; it buys NO extra deadline (see readRetainCounts).
   */
  withCounts?: boolean;
}

/** {@link readRetainCounts} options. The lens scoping is shared with
 *  {@link RetainFeedOpts}; the rest are seams `readRetainFeed` uses to hand
 *  down its own deadline and already-memoized full-corpus deps. */
export interface RetainCountsOpts {
  harnessScopes?: readonly string[];
  memberSlugs?: readonly string[];
  budgetMs?: number;
  /** Deadline to bound every count leg by. Omit to create one from `budgetMs`. */
  withinBudget?: WithinBudget;
  /** Pre-memoized full-corpus deps, so a caller that ALREADY read them for its
   *  rows does not read them a second time to count the same array. */
  listMemories?: (() => Promise<RetainMemorySource[]>) | undefined;
  listRubrics?: () => Promise<Array<{ slug: string; title: string; status: string; updatedAt: string }>>;
}

/** The SQL predicate mirroring {@link inRetainLegWindow}, over a subquery
 *  aliased `x` exposing ms-truncated `x.ts` + text `x.id`. COLLATE "C" pins the
 *  id tiebreak to byte order so SQL and JS agree regardless of DB collation. */
function legWindowSql(sql: Sql, w: RetainLegWindow | null) {
  if (!w) return sql`TRUE`;
  if (w.includeTies) return sql`x.ts <= ${w.beforeTs}::timestamptz`;
  if (w.tieIdAfter != null)
    return sql`(x.ts < ${w.beforeTs}::timestamptz OR (x.ts = ${w.beforeTs}::timestamptz AND x.id COLLATE "C" > ${w.tieIdAfter}))`;
  return sql`x.ts < ${w.beforeTs}::timestamptz`;
}

/** The canonical-store population behind Mem0Backend.list() for a set of
 * resolved pools. Keep this ONE predicate shared by the bounded page and exact
 * count: `row_kind` excludes mem0's entity graph, `state` preserves the
 * backend's archived-row rule, and the validity clause preserves its default
 * current-only read. */
function canonicalRetainMemoryCorpusSql(sql: Sql, scopes: readonly string[]) {
  return sql`m.row_kind = 'memory'
    AND m.state <> 'archived'
    AND (m.invalid_at IS NULL OR m.invalid_at > now())
    AND m.user_id = ANY(${scopes as string[]}::text[])`;
}

/**
 * One canonical/keyset page for the Retain memory leg.
 *
 * This is deliberately a capability rather than a replacement for the
 * pluggable backend seam. `retainStoreDeps` exposes it only for the two active
 * backends whose list semantics are this canonical table (`mem0` and
 * `hybrid-pg`); every other backend keeps the legacy `backend.list()` path.
 */
export async function listCanonicalRetainMemoriesPage(
  sql: Sql,
  scopes: readonly string[],
  opts: { window: RetainLegWindow | null; limit: number },
): Promise<RetainMemorySource[]> {
  if (scopes.length === 0) return [];
  const rows = (await sql`
    SELECT x.id, x.payload, x.ts
      FROM (
        SELECT m.id::text AS id,
               m.payload,
               date_trunc('milliseconds',
                 COALESCE(m.updated_at, m.created_at, to_timestamp(0))) AS ts
          FROM harness_shared.memory_canonical m
         WHERE ${canonicalRetainMemoryCorpusSql(sql, scopes)}
      ) x
     WHERE ${legWindowSql(sql, opts.window)}
     ORDER BY x.ts DESC, x.id COLLATE "C" ASC
     LIMIT ${opts.limit}
  `) as Array<{ id: string; payload: Record<string, unknown> | null; ts: Date | string | null }>;

  return rows.map((row) => {
    const payload = row.payload ?? {};
    const metadata = Object.fromEntries(
      Object.entries(payload).filter(
        ([key]) =>
          !['user_id', 'agent_id', 'run_id', 'hash', 'data', 'createdAt', 'updatedAt', 'textLemmatized', 'attributedTo'].includes(
            key,
          ),
      ),
    );
    const ts = toIsoMs(row.ts) ?? '1970-01-01T00:00:00.000Z';
    const kind = typeof payload.kind === 'string' ? payload.kind : undefined;
    return {
      id: row.id,
      text: typeof payload.data === 'string' ? payload.data : String(payload.data ?? ''),
      ...(kind !== undefined ? { kind } : {}),
      // Canonical table activity is the keyset order. Stamp it into the
      // neutral metadata spelling retainMemoryTsOf already consumes.
      metadata: { ...metadata, updated_at: ts },
    };
  });
}

/** Exact badge denominator for {@link listCanonicalRetainMemoriesPage}. */
export async function countCanonicalRetainMemories(sql: Sql, scopes: readonly string[]): Promise<number> {
  if (scopes.length === 0) return 0;
  const rows = (await sql`
    SELECT count(*)::int AS n
      FROM harness_shared.memory_canonical m
     WHERE ${canonicalRetainMemoryCorpusSql(sql, scopes)}
  `) as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Whole-read budget for one Retained page, in ms — comfortably under the
 * ~10s RESOLVER_READ_TIMEOUT_MS this exists to stay beneath, and ~2.6x the
 * ~2.3s a healthy loaded read measured on 2026-08-18.
 *
 * See ./read-deadline for WHY a bound is needed at all (a per-leg try/catch
 * isolates a leg that THROWS but not one that HANGS — WI-39813, the owner's
 * "Loading retained items… forever") and why it is a shared DEADLINE rather
 * than a per-call budget (this read has two sequential fan-outs: rows, then
 * counts).
 */
const RETAIN_READ_BUDGET_MS = 6_000;

/** A plan is "in flight" while it can still ship; superseded is abandoned. */
const PLAN_INFLIGHT_EXCLUDED = ['shipped', 'superseded'];

/**
 * One page of the unified Retained ledger. Five legs fetch up to `limit` rows
 * each strictly after the cursor, then a k-way merge emits the top `limit` in
 * (ts DESC, kind ASC, id ASC) order. If the merged candidate set is smaller
 * than `limit`, every active leg is exhausted and `nextCursor` is null.
 *
 * The Shipped ∕ In-flight filter is applied SERVER-side per leg (it must
 * compose with the cursor — a client-side filter over a paged feed drops rows
 * unpredictably), and only statusful kinds (plan, wi) participate in a filtered
 * feed. Counts are corpus sizes, filter-independent, first page only.
 */
export async function readRetainFeed(
  sql: Sql,
  workspaceId: string,
  deps: RetainFeedDeps,
  opts: RetainFeedOpts = {},
): Promise<RetainFeedPage> {
  const generatedAt = new Date().toISOString();
  const tab: RetainFeedTab = opts.tab ?? 'all';
  const filter: RetainFeedFilter = opts.filter ?? 'all';
  const limit = Math.max(1, Math.min(RETAIN_FEED_MAX_PAGE, Math.floor(opts.limit ?? RETAIN_FEED_PAGE_SIZE)));
  const cursor = typeof opts.cursor === 'string' ? decodeRetainCursor(opts.cursor) : (opts.cursor ?? null);

  const tabKinds: RetainFeedKind[] =
    tab === 'all' ? ['memory', 'plan', 'wi', 'rubric', 'runbook', 'recipe'] : [RETAIN_KIND_FOR_TAB[tab]];
  // "Filters apply where a type has statuses": a non-all filter narrows the
  // feed to the kinds that can be shipped/in flight at all.
  const kinds = filter === 'all' ? tabKinds : tabKinds.filter((k) => k === 'plan' || k === 'wi');

  const degraded: string[] = [];
  const shippedArr = [...ISSUE_SHIPPED_STATUSES];
  const abandonedArr = [...ISSUE_ABANDONED_STATUSES];

  // ONE deadline for the WHOLE read — the rows fan-out and then the counts
  // fan-out share it, so the two phases can never sum past it. Anything still
  // outstanding when it passes is treated exactly like a leg that threw:
  // recorded in `degraded` / nulled, never left to hang the page.
  const withinBudget = createReadDeadline(opts.budgetMs ?? RETAIN_READ_BUDGET_MS);

  // `listRubrics`, and `listMemories` on the LEGACY compatibility path, can be
  // consumed twice per page: once by their own leg and once by inline counts.
  // Memoize per invocation so the fallback never doubles a full-corpus read.
  // Canonical-backed memory callers expose independent page/count capabilities
  // instead: the bounded rows and exact denominator need not materialize one
  // shared array merely to agree.
  //
  // Rejection semantics are unchanged. A shared rejected promise is still
  // observed by both consumers, and both already handle it — the leg via the
  // per-leg try/catch that records `degraded`, the count via its own `.catch`
  // — so a failure still degrades visibly rather than throwing the page.
  const memoOnce = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
    let cached: Promise<T> | null = null;
    return () => (cached ??= fn());
  };
  // Called through `deps` rather than as a detached reference so a dep
  // implemented as a real method keeps its `this`.
  const listMemoriesOnce = deps.listMemories ? memoOnce(() => deps.listMemories!()) : undefined;
  const listRubricsOnce = memoOnce(() => deps.listRubrics());

  const legMemories = async (): Promise<RetainFeedRow[]> => {
    const w = retainLegWindowFor('memory', cursor);
    const source = deps.listMemoriesPage
      ? await deps.listMemoriesPage({ window: w, limit })
      : listMemoriesOnce
        ? await listMemoriesOnce()
        : (() => {
            throw new Error('listMemories dep not wired');
          })();
    return source
      .flatMap((e) => {
        if (!e.id || !e.text) return [];
        const m = e.metadata ?? {};
        const packId = typeof m.pack_id === 'string' && m.source === 'pack' ? m.pack_id : undefined;
        const createdBy = typeof m.created_by === 'string' && m.created_by ? m.created_by : undefined;
        return [
          {
            kind: 'memory' as const,
            id: e.id,
            title: retainMemoryTitle(e.text),
            ts: retainMemoryTsOf(e.metadata),
            status: null,
            shipped: false,
            meta: {
              ...(e.kind ? { memKind: e.kind } : {}),
              ...(createdBy ? { createdBy } : {}),
              ...(packId ? { packId } : {}),
            },
          },
        ];
      })
      .filter((row) => inRetainLegWindow(row.ts, row.id, w))
      .sort(compareRetainRows)
      .slice(0, limit);
  };

  const legPlans = async (): Promise<RetainFeedRow[]> => {
    const w = retainLegWindowFor('plan', cursor);
    const filterPred =
      filter === 'shipped'
        ? sql`x.status = 'shipped'`
        : filter === 'inflight'
          ? sql`x.status <> ALL(${PLAN_INFLIGHT_EXCLUDED}::text[])`
          : sql`TRUE`;
    const rows = (await sql`
      SELECT * FROM (
        SELECT DISTINCT ON (hp.plan_slug)
               hp.plan_slug AS id,
               COALESCE(NULLIF(hp.title, ''), hp.plan_slug) AS title,
               COALESCE(hp.status, '') AS status,
               date_trunc('milliseconds',
                 GREATEST(hp.updated_at, to_timestamp(r.routed_at / 1000.0))) AS ts,
               r.idea_id, r.title AS idea_title, r.lens,
               c.child_total, c.child_done
          FROM harness_shared.scout_routed_ideas r
          JOIN harness_shared.harness_plans hp
            ON hp.workspace_id = r.workspace_id
           AND hp.plan_slug = substring(r.routed_ref from 6)
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS child_total,
                   count(*) FILTER (WHERE ei.state = ANY(${shippedArr}::text[]))::int AS child_done
              FROM harness_shared.engineer_issues ei
             WHERE ei.workspace_id = r.workspace_id
               AND ei.source_plan_slug = hp.plan_slug
          ) c ON TRUE
         WHERE r.workspace_id = ${workspaceId}
           AND r.rail = 'plan'
           AND r.routed_ref LIKE 'plan:%'
           AND ${opts.memberSlugs ? sql`hp.harness_slug = ANY(${opts.memberSlugs as string[]}::text[])` : sql`TRUE`}
         ORDER BY hp.plan_slug, r.routed_at DESC
      ) x
      WHERE ${filterPred} AND ${legWindowSql(sql, w)}
      ORDER BY x.ts DESC, x.id COLLATE "C" ASC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const ts = toIsoMs(r.ts);
      const id = String(r.id ?? '');
      if (!ts || !id) return [];
      const status = String(r.status ?? '');
      return [
        {
          kind: 'plan' as const,
          id,
          title: String(r.title ?? id),
          ts,
          status,
          shipped: status === 'shipped',
          meta: {
            ideaId: String(r.idea_id ?? ''),
            ideaTitle: typeof r.idea_title === 'string' && r.idea_title ? r.idea_title : null,
            lens: String(r.lens ?? ''),
            childTotal: Number(r.child_total ?? 0),
            childDone: Number(r.child_done ?? 0),
          },
        },
      ];
    });
  };

  const legWi = async (): Promise<RetainFeedRow[]> => {
    const w = retainLegWindowFor('wi', cursor);
    const filterPred =
      filter === 'shipped'
        ? sql`x.shipped`
        : filter === 'inflight'
          ? sql`NOT x.shipped AND x.status <> ALL(${abandonedArr}::text[])`
          : sql`TRUE`;
    // ⚠ The `= ANY(ARRAY(SELECT …))` form is LOAD-BEARING, not a style choice.
    // Written as a plain join (`JOIN engineer_issues ei ON ei.issue_id =
    // substring(r.routed_ref from 4)`) the planner cannot see that only ~1k ids
    // can match, so it hash-joins the WHOLE work_items table: measured
    // 2026-08-19 on the live corpus, seq scan of 67,828 rows / 19,734 buffers
    // (~154MB) / 14MB hash, 104ms warm — and far worse cold, which is what the
    // owner experienced as "a few seconds" on this tab. Materializing the id
    // list into an InitPlan lets it index-scan work_items_pkey instead:
    // 17.8ms / 2,781 buffers for the SAME 905 rows. If you rewrite this join,
    // re-run EXPLAIN and confirm you still get "Index Scan using
    // work_items_pkey … Index Cond: (feature_id = ANY …)", never a Seq Scan.
    const routedWiIds = sql`ARRAY(
      SELECT DISTINCT substring(r2.routed_ref from 4)
        FROM harness_shared.scout_routed_ideas r2
       WHERE r2.workspace_id = ${workspaceId}
         AND r2.routed_ref LIKE 'wi:%'
    )`;
    const rows = (await sql`
      WITH routed_wi AS MATERIALIZED (
        SELECT ei.issue_id, ei.title, ei.state, ei.updated_at
          FROM harness_shared.engineer_issues ei
         WHERE ei.workspace_id = ${workspaceId}
           AND ei.source_plan_slug IS NULL
           AND ${opts.harnessScopes ? sql`ei.scope = ANY(${opts.harnessScopes as string[]}::text[])` : sql`TRUE`}
           AND ei.issue_id = ANY(${routedWiIds})
      )
      SELECT * FROM (
        SELECT DISTINCT ON (ei.issue_id)
               ei.issue_id AS id,
               COALESCE(NULLIF(ei.title, ''), r.title, ei.issue_id) AS title,
               COALESCE(ei.state, '') AS status,
               (ei.state = ANY(${shippedArr}::text[])) AS shipped,
               date_trunc('milliseconds', ei.updated_at) AS ts,
               r.idea_id, r.title AS idea_title, r.lens
          FROM harness_shared.scout_routed_ideas r
          JOIN routed_wi ei
            ON ei.issue_id = substring(r.routed_ref from 4)
         WHERE r.workspace_id = ${workspaceId}
           AND r.routed_ref LIKE 'wi:%'
         ORDER BY ei.issue_id, r.routed_at DESC
      ) x
      WHERE ${filterPred} AND ${legWindowSql(sql, w)}
      ORDER BY x.ts DESC, x.id COLLATE "C" ASC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const ts = toIsoMs(r.ts);
      const id = String(r.id ?? '');
      if (!ts || !id) return [];
      return [
        {
          kind: 'wi' as const,
          id,
          title: String(r.title ?? id),
          ts,
          status: String(r.status ?? ''),
          shipped: Boolean(r.shipped),
          meta: {
            ideaId: String(r.idea_id ?? ''),
            ideaTitle: typeof r.idea_title === 'string' && r.idea_title ? r.idea_title : null,
            lens: String(r.lens ?? ''),
          },
        },
      ];
    });
  };

  const legRubrics = async (): Promise<RetainFeedRow[]> => {
    const w = retainLegWindowFor('rubric', cursor);
    const all = await listRubricsOnce();
    return all
      .flatMap((r) => {
        const ts = toIsoMs(r.updatedAt);
        if (!ts || !r.slug) return [];
        return [
          {
            kind: 'rubric' as const,
            id: r.slug,
            title: r.title || r.slug,
            ts,
            status: r.status || null,
            shipped: false,
            meta: {},
          },
        ];
      })
      .filter((row) => inRetainLegWindow(row.ts, row.id, w))
      .sort(compareRetainRows)
      .slice(0, limit);
  };

  const legRunbooks = async (): Promise<RetainFeedRow[]> => {
    const w = retainLegWindowFor('runbook', cursor);
    const docs = await deps.listRunbooksPage({ window: w, limit });
    return docs.flatMap((d) => {
      const ts = toIsoMs(d.ts);
      if (!ts || !d.slug) return [];
      return [
        {
          kind: 'runbook' as const,
          id: d.slug,
          title: d.title || d.slug,
          ts,
          status: null,
          shipped: false,
          meta: { discovered: d.discovered },
        },
      ];
    });
  };

  const legRecipes = async (): Promise<RetainFeedRow[]> => {
    const w = retainLegWindowFor('recipe', cursor);
    const page = await deps.listRecipesPage({ window: w, limit });
    return page.flatMap((r) => {
      const ts = toIsoMs(r.ts);
      if (!ts || !r.id) return [];
      return [
        {
          kind: 'recipe' as const,
          id: r.id,
          title: r.title || r.id,
          ts,
          status: null,
          shipped: false,
          meta: { runCount: r.runCount },
        },
      ];
    });
  };

  const legFns: Record<RetainFeedKind, () => Promise<RetainFeedRow[]>> = {
    memory: legMemories,
    plan: legPlans,
    wi: legWi,
    rubric: legRubrics,
    runbook: legRunbooks,
    recipe: legRecipes,
  };

  const legRows = await Promise.all(
    kinds.map(async (k) => {
      try {
        // Budgeted: a leg that HANGS must degrade exactly like one that throws,
        // which is what keeps one wedged store from 500-ing the whole page.
        return await withinBudget(legFns[k](), `${k} leg`);
      } catch (err) {
        degraded.push(k);
        console.warn(`[learning.retainFeed] ${k} leg failed:`, err instanceof Error ? err.message : err);
        return [] as RetainFeedRow[];
      }
    }),
  );

  const merged = legRows.flat().sort(compareRetainRows);
  const rows = merged.slice(0, limit);
  // Fewer candidates than a full page means every leg returned everything it
  // had after the cursor — the feed is exhausted. (A degraded leg reads as
  // exhausted too; `degraded` discloses it.)
  const last = rows[rows.length - 1];
  const nextCursor =
    last && merged.length >= limit ? encodeRetainCursor({ ts: last.ts, kind: last.kind, id: last.id }) : null;

  const counts: RetainFeedCounts | null =
    opts.withCounts && !cursor
      ? await readRetainCounts(sql, workspaceId, deps, {
          ...opts,
          // Share the ROWS' deadline: opting counts back in must not buy a
          // second budget (see read-deadline.ts, "why a deadline and not a
          // per-call budget"), and must not re-read the full-corpus deps the
          // legs already memoized above.
          withinBudget,
          listMemories: listMemoriesOnce,
          listRubrics: listRubricsOnce,
        })
      : null;

  return { rows, nextCursor, counts, degraded, generatedAt };
}

/**
 * The tab-badge corpus sizes — filter-INDEPENDENT, and DELIBERATELY NOT part of
 * a feed page (WI-39900, owner report 2026-08-19 "it should be near instant").
 *
 * These six counts were computed inline on every FIRST page, for ALL SIX kinds,
 * regardless of which tab was selected — so opening the Runbooks tab paid for
 * the memory, rubric, recipe and work-item corpora too. Measured on the live
 * corpus: Runbooks first page 4.79s with the counts vs **0.024s** with them
 * skipped; the `all` tab 1.0s vs 0.13s. The rows were never the slow part.
 *
 * Splitting them is not only about milliseconds. The memories count is a
 * FULL-CORPUS read over the memory backend, whose measured p50 is ~10.9s with
 * 69% of calls hitting a >=10s timeout (WI-39554) — so while the counts rode
 * the page, every tab's ROWS were hostage to that store, and a hiccup spent the
 * whole 6s read budget before rendering anything. Now the ledger renders off
 * its keyset-paged legs and the badges arrive on their own query.
 *
 * Every leg still degrades to `null` independently: a badge whose count could
 * not be read renders as unknown, NEVER as 0 (a confident zero over a nonempty
 * corpus is the failure this nullability exists to prevent).
 */
export async function readRetainCounts(
  sql: Sql,
  workspaceId: string,
  deps: RetainFeedDeps,
  opts: RetainCountsOpts = {},
): Promise<RetainFeedCounts> {
  const withinBudget = opts.withinBudget ?? createReadDeadline(opts.budgetMs ?? RETAIN_READ_BUDGET_MS);
  const listMemories = opts.listMemories ?? deps.listMemories;
  const listRubrics = opts.listRubrics ?? (() => deps.listRubrics());
  const [memories, plans, wi, rubrics, runbooks, recipes] = await Promise.all([
      deps.countMemories
        ? withinBudget(deps.countMemories(), 'memories count').catch(() => null)
        : listMemories
        ? withinBudget(
            listMemories().then((r) => r.length),
            'memories count',
          ).catch(() => null)
        : Promise.resolve(null),
      withinBudget(
        (async () => {
          const r = (await sql`
          SELECT count(DISTINCT hp.plan_slug)::int AS n
            FROM harness_shared.scout_routed_ideas r
            JOIN harness_shared.harness_plans hp
              ON hp.workspace_id = r.workspace_id
             AND hp.plan_slug = substring(r.routed_ref from 6)
           WHERE r.workspace_id = ${workspaceId}
             AND r.rail = 'plan'
             AND r.routed_ref LIKE 'plan:%'
             AND ${opts.memberSlugs ? sql`hp.harness_slug = ANY(${opts.memberSlugs as string[]}::text[])` : sql`TRUE`}
        `) as Array<{ n: number }>;
          return Number(r[0]?.n ?? 0);
        })(),
        'plans count',
      ).catch((err) => {
        console.warn('[learning.retainFeed] plans count failed:', err instanceof Error ? err.message : err);
        return null;
      }),
      withinBudget(
        (async () => {
          // Same `= ANY(ARRAY(SELECT …))` shape — and for the same reason — as
          // legWi above (79ms/20,141 buffers as a plain join → index scan here).
          // `count(DISTINCT issue_id)` is NOT interchangeable with `count(*)`:
          // 91 issue_ids are duplicated across harnesses inside this workspace,
          // so a plain count over-reports the badge by exactly those rows
          // (measured 906 vs the correct 905, 2026-08-19).
          const r = (await sql`
          SELECT count(DISTINCT ei.issue_id)::int AS n
            FROM harness_shared.engineer_issues ei
           WHERE ei.workspace_id = ${workspaceId}
             AND ei.source_plan_slug IS NULL
             AND ${opts.harnessScopes ? sql`ei.scope = ANY(${opts.harnessScopes as string[]}::text[])` : sql`TRUE`}
             AND ei.issue_id = ANY(ARRAY(
                   SELECT DISTINCT substring(r2.routed_ref from 4)
                     FROM harness_shared.scout_routed_ideas r2
                    WHERE r2.workspace_id = ${workspaceId}
                      AND r2.routed_ref LIKE 'wi:%'
                 ))
        `) as Array<{ n: number }>;
          return Number(r[0]?.n ?? 0);
        })(),
        'wi count',
      ).catch((err) => {
        console.warn('[learning.retainFeed] wi count failed:', err instanceof Error ? err.message : err);
        return null;
      }),
      withinBudget(
        listRubrics().then((r) => r.length),
        'rubrics count',
      ).catch(() => null),
      withinBudget(deps.countRunbooks(), 'runbooks count').catch(() => null),
      withinBudget(deps.countRecipes(), 'recipes count').catch(() => null),
    ]);
  return { memories, plans, wi, rubrics, runbooks, recipes };
}

/** The plan-born work items behind one expanded plan row, newest activity
 *  first. Best-effort: a read failure degrades to []. */
export async function readRetainPlanChildren(
  sql: Sql,
  workspaceId: string,
  planSlug: string,
  limit = 100,
): Promise<RetainPlanChild[]> {
  // '' = no plan expanded. The client keeps this read mounted under the view's
  // shared readiness gate (one gate per view — lens-guard), so the un-expanded
  // state must be a free no-op, not a DB round-trip.
  if (!planSlug) return [];
  try {
    const shippedArr = [...ISSUE_SHIPPED_STATUSES];
    const rows = (await sql`
      SELECT ei.issue_id AS id,
             COALESCE(NULLIF(ei.title, ''), ei.issue_id) AS title,
             COALESCE(ei.state, '') AS status,
             (ei.state = ANY(${shippedArr}::text[])) AS shipped,
             date_trunc('milliseconds', ei.updated_at) AS ts
        FROM harness_shared.engineer_issues ei
       WHERE ei.workspace_id = ${workspaceId}
         AND ei.source_plan_slug = ${planSlug}
       ORDER BY ts DESC NULLS LAST
       LIMIT ${Math.max(1, Math.min(500, limit))}
    `) as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const id = String(r.id ?? '');
      if (!id) return [];
      return [
        {
          id,
          title: String(r.title ?? id),
          status: String(r.status ?? ''),
          shipped: Boolean(r.shipped),
          ts: toIsoMs(r.ts) ?? '',
        },
      ];
    });
  } catch (err) {
    console.warn('[learning.retainPlanChildren] read failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── Row detail (WI-39534) ───────────────────────────────────────────────────

export interface RetainDetailDeps {
  getRubric: (id: string) => Promise<{
    title: string;
    description: string;
    status: string;
    characteristic: string;
    criteria: Array<{ label?: string; title?: string; id?: string }>;
    updatedAt: string;
  } | null>;
  getRecipe: (id: string) => Promise<{
    title: string;
    description: string;
    script: string;
    potSlug: string | null;
    toolsUsed: string[];
    runCount: number;
    successCount: number;
    lastRunAt: string | null;
    status: string;
    createdBy: string | null;
    updatedAt: string;
  } | null>;
  /** Raw runbook doc text by slug (frontmatter included); null = not found. */
  readRunbook: (slug: string) => Promise<{ text: string; ts: string | null } | null>;
  /** One shared-memory entry by id, with its pool scope when known. */
  getMemory: (id: string) => Promise<(RetainMemorySource & { scope?: string }) | null>;
}

function clampDetailBody(text: string | null | undefined): { body: string | null; bodyTruncated: boolean } {
  if (!text) return { body: null, bodyTruncated: false };
  const trimmed = text.trim();
  if (!trimmed) return { body: null, bodyTruncated: false };
  if (trimmed.length <= RETAIN_DETAIL_BODY_MAX) return { body: trimmed, bodyTruncated: false };
  return { body: trimmed.slice(0, RETAIN_DETAIL_BODY_MAX), bodyTruncated: true };
}

function detailField(label: string, value: unknown): Array<{ label: string; value: string }> {
  if (value == null) return [];
  const s = typeof value === 'string' ? value : String(value);
  return s ? [{ label, value: s }] : [];
}

/** Strip a leading `--- … ---` frontmatter block off a runbook doc. */
export function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/**
 * One ledger row's expanded detail (WI-39534): body/provenance beyond the
 * row's title+status, per kind, in ONE neutral shape. Best-effort like every
 * retain read — a store failure or unknown id resolves to null (the client
 * renders "detail unavailable"), never a 500.
 */
export async function readRetainDetail(
  sql: Sql,
  workspaceId: string,
  kind: RetainFeedKind,
  id: string,
  deps: RetainDetailDeps,
): Promise<RetainDetail | null> {
  if (!id) return null;
  try {
    switch (kind) {
      case 'plan': {
        const rows = (await sql`
          SELECT hp.title, hp.status, hp.content, hp.harness_slug, hp.now_state,
                 date_trunc('milliseconds', hp.updated_at) AS ts,
                 r.idea_id, r.title AS idea_title, r.lens,
                 to_timestamp(r.routed_at / 1000.0) AS routed_ts
            FROM harness_shared.harness_plans hp
            LEFT JOIN LATERAL (
              SELECT ri.idea_id, ri.title, ri.lens, ri.routed_at
                FROM harness_shared.scout_routed_ideas ri
               WHERE ri.workspace_id = hp.workspace_id
                 AND ri.rail = 'plan'
                 AND ri.routed_ref = 'plan:' || hp.plan_slug
               ORDER BY ri.routed_at DESC
               LIMIT 1
            ) r ON TRUE
           WHERE hp.workspace_id = ${workspaceId}
             AND hp.plan_slug = ${id}
           LIMIT 1
        `) as Array<Record<string, unknown>>;
        const r = rows[0];
        if (!r) return null;
        return {
          kind,
          id,
          title: String(r.title ?? id),
          status: typeof r.status === 'string' && r.status ? r.status : null,
          ts: toIsoMs(r.ts),
          ...clampDetailBody(typeof r.content === 'string' ? r.content : null),
          fields: [
            ...detailField('Harness', r.harness_slug),
            ...detailField('Now', r.now_state),
            ...detailField('From idea', r.idea_title ?? r.idea_id),
            ...detailField('Lens', r.lens),
            ...detailField('Routed', toIsoMs(r.routed_ts)),
          ],
        };
      }
      case 'wi': {
        const rows = (await sql`
          SELECT ei.title, ei.state, ei.body, ei.severity, ei.created_by, ei.scope,
                 date_trunc('milliseconds', ei.updated_at) AS ts,
                 date_trunc('milliseconds', ei.created_at) AS created_ts,
                 r.idea_id, r.title AS idea_title, r.lens
            FROM harness_shared.engineer_issues ei
            LEFT JOIN LATERAL (
              SELECT ri.idea_id, ri.title, ri.lens
                FROM harness_shared.scout_routed_ideas ri
               WHERE ri.workspace_id = ei.workspace_id
                 AND ri.routed_ref = 'wi:' || ei.issue_id
               ORDER BY ri.routed_at DESC
               LIMIT 1
            ) r ON TRUE
           WHERE ei.workspace_id = ${workspaceId}
             AND ei.issue_id = ${id}
           LIMIT 1
        `) as Array<Record<string, unknown>>;
        const r = rows[0];
        if (!r) return null;
        return {
          kind,
          id,
          title: String(r.title ?? id),
          status: typeof r.state === 'string' && r.state ? r.state : null,
          ts: toIsoMs(r.ts),
          ...clampDetailBody(typeof r.body === 'string' ? r.body : null),
          fields: [
            ...detailField('Severity', r.severity),
            ...detailField('Scope', r.scope),
            ...detailField('Created by', r.created_by),
            ...detailField('Created', toIsoMs(r.created_ts)),
            ...detailField('From idea', r.idea_title ?? r.idea_id),
            ...detailField('Lens', r.lens),
          ],
        };
      }
      case 'rubric': {
        const rubric = await deps.getRubric(id);
        if (!rubric) return null;
        return {
          kind,
          id,
          title: rubric.title || id,
          status: rubric.status || null,
          ts: toIsoMs(rubric.updatedAt),
          ...clampDetailBody(rubric.description),
          listItems: rubric.criteria
            .map((c) => c.label ?? c.title ?? c.id ?? '')
            .filter((s): s is string => Boolean(s)),
          fields: [...detailField('Characteristic', rubric.characteristic)],
        };
      }
      case 'runbook': {
        const doc = await deps.readRunbook(id);
        if (!doc) return null;
        const parsed = parseInsightFrontmatter(id, doc.text);
        return {
          kind,
          id,
          title: parsed.title,
          status: null,
          ts: doc.ts,
          ...clampDetailBody(stripFrontmatter(doc.text)),
          fields: [...detailField('Discovered', parsed.discovered)],
        };
      }
      case 'recipe': {
        const recipe = await deps.getRecipe(id);
        if (!recipe) return null;
        const { body, bodyTruncated } = clampDetailBody(recipe.description);
        const script = recipe.script?.trim() ?? '';
        return {
          kind,
          id,
          title: recipe.title || id,
          status: recipe.status || null,
          ts: toIsoMs(recipe.lastRunAt) ?? toIsoMs(recipe.updatedAt),
          body,
          bodyTruncated: bodyTruncated || script.length > RETAIN_DETAIL_BODY_MAX,
          ...(script ? { code: script.slice(0, RETAIN_DETAIL_BODY_MAX) } : {}),
          fields: [
            ...detailField('Runs', recipe.runCount ? `${recipe.successCount}/${recipe.runCount} ok` : null),
            ...detailField('Last run', toIsoMs(recipe.lastRunAt)),
            ...detailField('Pot', recipe.potSlug),
            ...detailField('Author', recipe.createdBy),
            ...detailField('Tools', recipe.toolsUsed.length ? recipe.toolsUsed.join(', ') : null),
          ],
        };
      }
      case 'memory': {
        const entry = await deps.getMemory(id);
        if (!entry) return null;
        const m = entry.metadata ?? {};
        const isPack = m.source === 'pack' && typeof m.pack_id === 'string';
        return {
          kind,
          id,
          title: retainMemoryTitle(entry.text),
          status: null,
          ts: retainMemoryTsOf(entry.metadata),
          ...clampDetailBody(entry.text),
          editable: true,
          fields: [
            ...detailField('Kind', entry.kind),
            ...detailField('Created by', typeof m.created_by === 'string' ? m.created_by : null),
            ...detailField(
              'Pack',
              isPack ? `${String(m.pack_id)}${m.pack_version ? ` @${String(m.pack_version)}` : ''}` : null,
            ),
            ...detailField(
              'Applies to',
              Array.isArray(m.applies_to) && m.applies_to.length ? (m.applies_to as string[]).join(', ') : null,
            ),
            ...detailField('Pool', entry.scope),
          ],
        };
      }
    }
  } catch (err) {
    console.warn(`[learning.retainDetail] ${kind} read failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Insight-runbook fs legs ─────────────────────────────────────────────────

/**
 * One keyset page of agent-insight docs by file mtime. mtime prefilters (one
 * readdir + parallel stats), then only the selected page's files are opened for
 * their frontmatter — never a serial read over the whole 500+ doc corpus (A1).
 */
export async function readInsightDocsPage(
  contentDir: string,
  opts: { window: RetainLegWindow | null; limit: number },
): Promise<Array<{ slug: string; title: string; discovered: string | null; ts: string }>> {
  const names = (await fs.readdir(contentDir)).filter((n) => /\.(md|mdx)$/.test(n));
  const stats = await Promise.all(
    names.map(async (n) => {
      try {
        const st = await fs.stat(path.join(contentDir, n));
        return { name: n, slug: n.replace(/\.(md|mdx)$/, ''), ts: new Date(Math.floor(st.mtimeMs)).toISOString() };
      } catch {
        return null;
      }
    }),
  );
  const page = stats
    .filter((s): s is { name: string; slug: string; ts: string } => s !== null)
    .filter((s) => inRetainLegWindow(s.ts, s.slug, opts.window))
    .sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? 1 : -1) : a.slug < b.slug ? -1 : 1))
    .slice(0, Math.max(1, opts.limit));
  const docs = await Promise.all(
    page.map(async ({ name, slug, ts }) => {
      try {
        const text = await fs.readFile(path.join(contentDir, name), 'utf8');
        return { ...parseInsightFrontmatter(slug, text), ts };
      } catch {
        return null;
      }
    }),
  );
  return docs.filter((d): d is { slug: string; title: string; discovered: string | null; ts: string } => d !== null);
}

/** Corpus size of the insight-doc tree (the Runbooks tab badge). */
export async function countInsightDocs(contentDir: string): Promise<number> {
  return (await fs.readdir(contentDir)).filter((n) => /\.(md|mdx)$/.test(n)).length;
}
