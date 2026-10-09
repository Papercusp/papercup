/** Plan/doc adapters over the existing canonical prose and section indexes.
 * Audience is supplied by the host, before a source applies ranking or limits. */
import type { Listing, SearchSource, SearchSourceParams } from '@papercusp/search';
import { chunkAwareVectorLegSql, sectionAnchorBase } from '@papercusp/search';
import { PLANS_CHUNK_SURFACE } from '../../search/chunks/registry';
import { PROSE_EMBEDDING_SPACE } from '../../search/prose-vector-dims';
import { lastMarkdownHeading, planWindowMidpoint } from '../plans/semantic-leg';

export interface KnowledgeAudience {
  harnessSlugs?: readonly string[];
  automatic?: boolean;
  excludedRefs?: ReadonlySet<string>;
}

type SectionRow = {
  source_id: string; title: string; content: string; highlight: string;
  scope: string; rank: number; section: string | null; status: string | null;
  updated_at: string | Date | null; path: string; source_key?: string;
};

function listing(rows: SectionRow[], source: 'plan' | 'doc', ranker: string): Listing {
  return rows.map(r => ({ key: `${source}:${r.source_id}`, score: Number(r.rank), row: {
    source, source_id: r.source_id, scope: r.scope, ts: r.updated_at,
    excerpt: `${r.title}${r.section ? ` › ${r.section}` : ''}\n${r.content}`.slice(0, 1500),
    highlight: r.highlight || r.content.slice(0, 1500), score: Number(r.rank), rankers: [ranker],
    meta: { title: r.title, section: r.section, status: r.status,
      currentness: source === 'doc' ? 'maintained-procedure' : 'plan', path: r.path,
      ...(r.source_key ? { docSourceKey: r.source_key } : {}) },
  } }));
}

/** Keep a source's harness/ambient fence in SQL, including on vector legs. */
export function createPlanSearchSource(audience: KnowledgeAudience = {}): SearchSource {
  const filter = (p: SearchSourceParams) => p.sql`
    p.workspace_id = ${p.workspaceId} AND p.template_slug IS NULL
    AND (${p.scopeFilter}::text IS NULL OR p.harness_slug = ${p.scopeFilter})
    AND (${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[] IS NULL
      OR p.harness_slug = ANY(${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[]))
    AND NOT (('plan:' || p.harness_slug || ':' || p.plan_slug) = ANY(${[...(audience.excludedRefs ?? [])]}::text[]))
    ${audience.automatic ? p.sql`AND p.archived = false AND p.status <> 'superseded'` : p.sql``}`;
  const map = (rows: Array<Record<string, unknown>>, ranker: string) => listing(rows.map(r => {
    const harness = String(r.harness_slug), slug = String(r.plan_slug);
    const content = String(r.match_content ?? r.content ?? '');
    const section = r.section_prefix ? lastMarkdownHeading(String(r.section_prefix)) : null;
    return { source_id: `${harness}:${slug}`, title: String(r.title ?? slug), content,
      highlight: String(r.highlight ?? content), scope: `harness:${harness}`, rank: Number(r.rank),
      section, status: String(r.status), updated_at: r.updated_at as string | Date,
      path: `/admin/plans?plan=${encodeURIComponent(slug)}` };
  }), 'plan', ranker);
  return {
    name: 'plan',
    async lexical(p) {
      const rows = await p.sql`SELECT p.plan_slug, p.harness_slug, p.title, p.status, p.updated_at,
        ts_rank_cd(to_tsvector('english', p.content), plainto_tsquery('english', ${p.query})) AS rank,
        ts_headline('english', p.content, plainto_tsquery('english', ${p.query}),
          'StartSel=<mark>,StopSel=</mark>,MaxWords=90,MinWords=30,MaxFragments=1') AS highlight
        FROM harness_shared.harness_plans p WHERE ${filter(p)}
          AND to_tsvector('english', p.content) @@ plainto_tsquery('english', ${p.query})
        ORDER BY rank DESC, p.plan_slug LIMIT ${p.limit}`;
      return map(rows as Array<Record<string, unknown>>, 'lexical');
    },
    async embedding(p) {
      if (!p.embeddingProfile) return [];
      const space = (profile: string | null, mode: string | null) => profile && mode
        ? PROSE_EMBEDDING_SPACE.sourceFilterSql(p, profile, mode) : p.sql`FALSE`;
      const best = chunkAwareVectorLegSql(p.sql, { surface: PLANS_CHUNK_SURFACE, qVec: p.qVec!,
        limit: p.limit, mode: 'retrieve', parentFilter: filter(p),
        spaceFilter: cols => space(cols.profileColumn, cols.modeColumn) });
      const rows = await p.sql`WITH best AS (${best})
        SELECT p.plan_slug, p.harness_slug, p.title, p.status, p.updated_at,
          1 - b.distance AS rank, coalesce(c.content, left(p.content, 1500)) AS match_content,
          CASE WHEN c.chunk_idx IS NULL THEN NULL
            ELSE left(p.content, ${planWindowMidpoint(0)} + c.chunk_idx * 1250) END AS section_prefix
        FROM best b JOIN harness_shared.harness_plans p
          ON p.workspace_id = b.workspace_id AND p.harness_slug = b.harness_slug AND p.plan_slug = b.plan_slug
        LEFT JOIN LATERAL (SELECT c.content, c.chunk_idx FROM harness_shared.text_chunks c
          WHERE c.surface = 'plans' AND c.parent_key = ARRAY[p.workspace_id,p.harness_slug,p.plan_slug]
            AND c.embedding IS NOT NULL AND ${space('c.embedding_profile', 'c.embedding_mode')}
          ORDER BY c.embedding <=> ${p.qVec}::vector, c.chunk_idx LIMIT 1) c ON true
        ORDER BY b.distance, p.plan_slug`;
      return map(rows as Array<Record<string, unknown>>, 'embeddings');
    },
  };
}

/** doc_sections is a derived complete-body cache, scoped by the source key.
 * Framework docs are shared; harness docs require workspace membership. */
export function createDocSearchSource(audience: KnowledgeAudience = {}): SearchSource {
  const filter = (p: SearchSourceParams) => p.sql`
    (s.source_key = 'papercusp-engineering' OR EXISTS (
      SELECT 1 FROM harness_shared.harness_registry h
      WHERE h.workspace_id = ${p.workspaceId} AND s.source_key = 'harness:' || h.slug
        AND (${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[] IS NULL
          OR h.slug = ANY(${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[]))))
    AND (${p.scopeFilter}::text IS NULL OR s.source_key = 'harness:' || ${p.scopeFilter}
      OR (${p.scopeFilter} = 'papercusp' AND s.source_key = 'papercusp-engineering'))
    AND NOT (('doc:' || s.source_key || ':' || s.slug) = ANY(${[...(audience.excludedRefs ?? [])]}::text[]))
    AND NOT EXISTS (SELECT 1 FROM harness_shared.harness_docs d
      WHERE d.workspace_id = ${p.workspaceId}
        AND d.harness_slug = CASE WHEN s.source_key = 'papercusp-engineering' THEN 'papercusp'
          ELSE substring(s.source_key from 9) END
        AND d.doc_id IN (s.slug || '.mdx',s.slug || '.md') AND d.retired_at IS NOT NULL)
    ${audience.automatic ? p.sql`AND s.slug NOT LIKE 'plans/%' AND s.slug NOT LIKE 'reference/plans-%'` : p.sql``}`;
  const map = (rows: Array<Record<string, unknown>>, ranker: string) => listing(rows.map(r => {
    const key = String(r.source_key), slug = String(r.slug), anchor = sectionAnchorBase(String(r.anchor));
    return { source_id: `${key}:${slug}`, title: String(r.title), content: String(r.content),
      highlight: String(r.highlight ?? r.content), scope: key === 'papercusp-engineering' ? 'operator' : key,
      rank: Number(r.rank), section: anchor || null, status: 'maintained', updated_at: null,
      path: String(r.url) + (anchor ? `#${anchor}` : ''), source_key: key };
  }), 'doc', ranker);
  return {
    name: 'doc',
    async lexical(p) {
      const rows = await p.sql`SELECT DISTINCT ON (s.source_key,s.slug) s.*,
        ts_rank_cd(to_tsvector('english', s.title || E'\n' || s.content), plainto_tsquery('english', ${p.query})) AS rank
        FROM harness_shared.doc_sections s WHERE ${filter(p)}
          AND to_tsvector('english', s.title || E'\n' || s.content) @@ plainto_tsquery('english', ${p.query})
        ORDER BY s.source_key,s.slug,rank DESC,s.anchor`;
      return map((rows as Array<Record<string, unknown>>).sort((a,b) => Number(b.rank)-Number(a.rank)).slice(0,p.limit), 'lexical');
    },
    async embedding(p) {
      if (!p.embeddingProfile) return [];
      const rows = await p.sql`SELECT DISTINCT ON (s.source_key,s.slug) s.*,
        1 - (s.embedding <=> ${p.qVec}::vector) AS rank
        FROM harness_shared.doc_sections s WHERE ${filter(p)} AND s.embedding IS NOT NULL
          AND ${PROSE_EMBEDDING_SPACE.sourceFilterSql(p, 's.embedding_profile', 's.embedding_mode')}
        ORDER BY s.source_key,s.slug,s.embedding <=> ${p.qVec}::vector,s.anchor`;
      return map((rows as Array<Record<string, unknown>>).sort((a,b) => Number(b.rank)-Number(a.rank)).slice(0,p.limit), 'embeddings');
    },
  };
}

