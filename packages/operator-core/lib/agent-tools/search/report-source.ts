import type { SearchSource, SearchSourceParams, Listing } from '@papercusp/search';
import { visibleTo, type ReportViewer } from '../../report-library';
import { PROSE_EMBEDDING_SPACE } from '../../search/prose-vector-dims';
import { reportsLibraryDisabled } from '../reports/_shared';

type HitRow = { report_id: string; title: string; summary: string; origin_harness_slug: string | null;
  published_at: string; rank: number; highlight: string };
function hits(rows: HitRow[], ranker: string): Listing {
  return rows.map(r => ({ key: `report:${r.report_id}`, score: Number(r.rank), row: {
    source: 'report', source_id: r.report_id, ...(r.origin_harness_slug ? { scope: r.origin_harness_slug } : {}),
    ts: r.published_at, excerpt: `${r.title}\n${r.summary}`.slice(0, 400), highlight: r.highlight,
    score: Number(r.rank), rankers: [ranker], meta: { path: `/reports?sel=${encodeURIComponent(r.report_id)}` },
  } }));
}

/** Viewer is captured by the server. Author/session filters never confer read access. */
export function createReportSearchSource(viewer: ReportViewer = {}): SearchSource {
  const latest = (p: SearchSourceParams) => p.sql`
    SELECT DISTINCT ON (lineage_id) report_id FROM harness_shared.report_library
    WHERE workspace_id = ${p.workspaceId} AND retired_at IS NULL AND ${visibleTo(p.sql, viewer)}
      AND (${p.scopeFilter}::text IS NULL OR origin_harness_slug = ${p.scopeFilter})
      AND (${p.filters?.owners ?? null}::text[] IS NULL OR author_owner_id = ANY(${p.filters?.owners ?? null}::text[]))
      AND (${p.filters?.since ?? null}::timestamptz IS NULL OR published_at >= ${p.filters?.since ?? null}::timestamptz)
      AND (${p.filters?.until ?? null}::timestamptz IS NULL OR published_at < ${p.filters?.until ?? null}::timestamptz)
    ORDER BY lineage_id, published_at DESC, report_id DESC`;
  return {
    name: 'report',
    async lexical(p) {
      if (await reportsLibraryDisabled()) return [];
      const rows = await p.sql`SELECT report_id, title, summary, origin_harness_slug, published_at,
        ts_rank_cd(search_tsv, plainto_tsquery('english', ${p.query})) AS rank,
        ts_headline('english', body_md, plainto_tsquery('english', ${p.query}),
          'StartSel=<mark>,StopSel=</mark>,MaxWords=35,MinWords=15,MaxFragments=2') AS highlight
        FROM harness_shared.report_library WHERE report_id IN (${latest(p)})
          AND search_tsv @@ plainto_tsquery('english', ${p.query}) ORDER BY rank DESC, report_id LIMIT ${p.limit}`;
      return hits(rows as unknown as HitRow[], 'lexical');
    },
    async embedding(p) {
      if (await reportsLibraryDisabled()) return [];
      // Reports have only chunk vectors. Pool by the nearest visible chunk;
      // visibility applies before ranking/limit and workspace is part of every join.
      const rows = await p.sql`WITH best AS (
        SELECT r.workspace_id, r.report_id, min(c.embedding <=> ${p.qVec}::vector) AS distance
        FROM harness_shared.report_library r JOIN harness_shared.text_chunks c
          ON c.surface = 'report' AND c.parent_key = ARRAY[r.workspace_id, r.report_id]
        WHERE r.workspace_id = ${p.workspaceId} AND r.report_id IN (${latest(p)})
          AND c.embedding IS NOT NULL
          AND ${PROSE_EMBEDDING_SPACE.sourceFilterSql(p, 'c.embedding_profile', 'c.embedding_mode')}
        GROUP BY r.workspace_id, r.report_id ORDER BY distance, r.report_id LIMIT ${p.limit}
      ) SELECT r.report_id, r.title, r.summary, r.origin_harness_slug, r.published_at,
        1 - b.distance AS rank,
        ts_headline('english', r.body_md, plainto_tsquery('english', ${p.query}),
          'StartSel=<mark>,StopSel=</mark>,MaxWords=35,MinWords=15,MaxFragments=2') AS highlight
        FROM best b JOIN harness_shared.report_library r
          ON r.workspace_id = b.workspace_id AND r.report_id = b.report_id ORDER BY b.distance, r.report_id`;
      return hits(rows as unknown as HitRow[], 'embeddings');
    },
  };
}
