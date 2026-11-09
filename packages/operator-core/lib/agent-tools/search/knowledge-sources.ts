/** Plan/doc adapters over the existing canonical prose and section indexes.
 * Audience is supplied by the host, before a source applies ranking or limits. */
import type { Listing, SearchSource, SearchSourceParams } from '@papercusp/search';
import type { Sql } from 'postgres';
import { chunkAwareVectorLegSql, sectionAnchorBase, withIterativeScan } from '@papercusp/search';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { PLANS_CHUNK_SURFACE } from '../../search/chunks/registry';
import { boundedExactTopK, headlineTsQuery, lexicalLeg, mergeExactAndBm25 } from '../../search/lexical/rank';
import { PROSE_EMBEDDING_SPACE } from '../../search/prose-vector-dims';
import { lastMarkdownHeading, planWindowMidpoint } from '../plans/semantic-leg';
import { contextSourceVersion, type ContextSourceVersion } from '../../memory/temporal-render';
import type { HarnessRegistry } from '../../harness-registry';

export interface KnowledgeAudience {
  harnessSlugs?: readonly string[];
  automatic?: boolean;
  excludedRefs?: ReadonlySet<string>;
  /** Work discovery: return structured items from current draft plans. */
  draftItems?: boolean;
}

/** Re-read previously delivered knowledge by stable ref, never by search rank.
 * The same workspace/harness/ambient fences apply even for closed sources.
 * Missing authority, deleted rows and composed caches establish no lifecycle. */
export async function revalidateKnowledgeSourceVersions(input: {
  sql: Sql; workspaceId: string; previous: readonly ContextSourceVersion[];
  audience: KnowledgeAudience; allowed: ReadonlySet<string>; signal?: AbortSignal;
}): Promise<ContextSourceVersion[]> {
  return boundedOrgTxn(async sql => {
    const versions: ContextSourceVersion[] = [];
    for (const previous of input.previous.slice(0, 8)) {
      input.signal?.throwIfAborted();
      if (input.audience.excludedRefs?.has(previous.ref)) continue;
      const plan = /^plan:([^:]+):(.+)$/.exec(previous.ref);
      if (plan && input.allowed.has('plan') && previous.namespace === `corpus:plan:${input.workspaceId}`) {
        const [, harness, slug] = plan;
        if (input.audience.harnessSlugs?.length && !input.audience.harnessSlugs.includes(harness)) continue;
        const [row] = await sql`SELECT title, content, updated_at, archived, status, superseded_by
          FROM harness_shared.harness_plans WHERE workspace_id = ${input.workspaceId}
            AND harness_slug = ${harness} AND plan_slug = ${slug} AND template_slug IS NULL`;
        if (!row || typeof row.content !== 'string') continue;
        versions.push(contextSourceVersion({ namespace: previous.namespace, ref: previous.ref,
          fullText: `${row.title ?? slug}\n${row.content}`, revision: null,
          updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
          validity: { status: row.superseded_by || row.status === 'superseded' ? 'superseded'
            : row.archived ? 'retracted' : 'current', validAt: null, invalidAt: null,
            supersededBy: typeof row.superseded_by === 'string' ? row.superseded_by : null } }));
        continue;
      }
      const doc = /^doc:(papercusp-engineering|harness:[^:]+):(.+)$/.exec(previous.ref);
      const fileSource = previous.namespace === `corpus:doc-file:${input.workspaceId}`;
      if (!doc || !input.allowed.has('doc') ||
          (!fileSource && previous.namespace !== `corpus:doc:${input.workspaceId}`)) continue;
      const [, key, slug] = doc;
      if (slug.startsWith('plans/') || slug.startsWith('reference/plans-')) continue;
      const harness = key === 'papercusp-engineering' ? 'papercusp' : key.slice('harness:'.length);
      if (key !== 'papercusp-engineering' && input.audience.harnessSlugs?.length &&
          !input.audience.harnessSlugs.includes(harness)) continue;
      const rows = await sql`SELECT d.content, d.content_mode, d.updated_at, d.retired_at
        FROM harness_shared.harness_docs d WHERE d.workspace_id = ${input.workspaceId}
          AND d.harness_slug = ${harness} AND d.doc_id = ANY(${[slug, `${slug}.mdx`, `${slug}.md`]}::text[])
          AND (${key} = 'papercusp-engineering' OR EXISTS (
            SELECT 1 FROM harness_shared.harness_registry h, jsonb_array_elements(h.payload->'projects') p
            WHERE h.workspace_id = ${input.workspaceId} AND p->>'slug' = ${harness}))
        ORDER BY (d.retired_at IS NOT NULL) DESC, (d.content_mode = 'composed') DESC, d.doc_id`;
      // Retirement wins across aliases. Only authored bytes establish source identity.
      const row = rows[0];
      if (fileSource) {
        // A new database authority, a vanished file or revoked membership is
        // unknown here. Never read a stale file projection after a DB deletion.
        if (rows.length) continue;
        const raw = await fileDocSource(sql, input.workspaceId, key, slug, input.signal);
        if (raw !== null) versions.push(contextSourceVersion({ namespace: previous.namespace, ref: previous.ref,
          fullText: raw, revision: null, updatedAt: null,
          validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } }));
        continue;
      }
      if (!row || row.content_mode !== 'authored' || typeof row.content !== 'string') continue;
      versions.push(contextSourceVersion({ namespace: previous.namespace, ref: previous.ref,
        fullText: row.content, revision: null,
        updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
        validity: { status: row.retired_at ? 'retracted' : 'current', validAt: null,
          invalidAt: row.retired_at == null ? null : new Date(row.retired_at).toISOString(), supersededBy: null } }));
    }
    return versions;
  }, { client: input.sql, signal: input.signal, readOnly: true, statementTimeoutMs: 1_500 });
}

/** File authority is distinct from authored PG rows and their projections.
 * Share the canonical docs:get source adapter, but never its default workspace,
 * process-global registry cache or project-docs environment override. */
async function fileDocSource(sql: Sql, workspaceId: string, key: string, slug: string,
  signal?: AbortSignal): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    let adapter: import('@papercusp/docs-engine').DocSource;
    if (key === 'papercusp-engineering') {
      const { engineeringAdapterForSlugs } = await import('../docs/_engineering-adapter');
      // The caller already read canonical aliases on this connection.
      adapter = engineeringAdapterForSlugs([slug], async () => new Map());
    } else {
      const [row] = await sql`SELECT payload FROM harness_shared.harness_registry
        WHERE workspace_id = ${workspaceId}`;
      if (!Array.isArray(row?.payload?.projects)) return null;
      const registry: HarnessRegistry = { projects: row.payload.projects };
      const harness = key.slice('harness:'.length);
      if (!registry.projects.some(project => project.slug === harness && typeof project.path === 'string')) return null;
      const { resolveAdapter } = await import('../docs/get');
      const resolved = await resolveAdapter(harness, { slugs: [slug], registry });
      if (resolved.error) return null;
      adapter = resolved.adapter;
    }
    const page = await adapter.getPage(slug);
    signal?.throwIfAborted();
    const raw = page ? await adapter.getSource?.(page) ?? null : null;
    signal?.throwIfAborted();
    return raw;
  } catch (error) {
    signal?.throwIfAborted();
    return null;
  }
}

type SectionRow = {
  source_id: string; title: string; content: string; highlight: string;
  contextUnit?: string | null;
  contextSourceVersion?: string | null;
  scope: string; rank: number; section: string | null; status: string | null;
  updated_at: string | Date | null; path: string; source_key?: string;
};

/** Automatic recall may quote only a complete canonical body, never a search
 * window. Keep the existing metadata carrier bounded; larger bodies resolve
 * through their source handle instead. */
export function completeContextUnit(body: string): string | null {
  return body.trim().length > 0 && body.length <= 1_500 ? body : null;
}

/** Use the existing cancellation/transaction contract on both search legs. */
export function boundedSource(source: SearchSource): SearchSource {
  const run = async (leg: NonNullable<SearchSource['lexical']>, p: SearchSourceParams, vector: boolean) => {
    const finishSetup = p.phaseTimer?.start('bounded-org-txn-setup');
    try {
      return await boundedOrgTxn(async sql => {
        finishSetup?.('fulfilled');
        return vector
          ? withIterativeScan(sql, tx => leg({ ...p, sql: tx }), {
            runReadOnlyTransaction: async body => body(sql),
          })
          : leg({ ...p, sql });
      }, {
        client: p.sql, signal: p.signal, readOnly: true, statementTimeoutMs: 1_500,
      });
    } catch (error) {
      finishSetup?.('rejected');
      throw error;
    }
  };
  return { ...source,
    lexical: p => run(source.lexical, p, false),
    embedding: source.embedding ? p => run(source.embedding!, p, true) : undefined,
  };
}

/** Preserve a little preceding context around the actual lexical match. */
export function sectionExcerpt(body: string, highlight: string, precedingChars = 300): { content: string; section: string | null } {
  const plain = highlight.replace(/<\/?mark>/g, '').trim();
  const snippetAt = plain ? body.indexOf(plain) : -1;
  const term = /<mark>(.*?)<\/mark>/.exec(highlight)?.[1];
  const termAt = term ? body.toLowerCase().indexOf(term.toLowerCase(), Math.max(0,snippetAt)) : -1;
  const at = termAt >= 0 ? termAt : snippetAt;
  const start = at < 0 ? 0 : Math.max(0, at - precedingChars);
  return { content: body.slice(start, start + 1_500),
    section: lastMarkdownHeading(body.slice(0, Math.max(0, at))) };
}

function listing(rows: SectionRow[], source: 'plan' | 'doc', ranker: string): Listing {
  return rows.map(r => ({ key: `${source}:${r.source_id}`, score: Number(r.rank), row: {
    source, source_id: r.source_id, scope: r.scope, ts: r.updated_at,
    excerpt: `${r.title.slice(0,100)}${r.section ? ` › ${r.section.slice(0,100)}` : ''}\n${r.content}`.slice(0, 1500),
    highlight: r.highlight || r.content.slice(0, 1500), score: Number(r.rank), rankers: [ranker],
    meta: { title: r.title, section: r.section, status: r.status,
      contextUnit: r.contextUnit ?? null,
      contextSourceVersion: r.contextSourceVersion ?? null,
      currentness: source === 'doc' ? 'maintained-procedure' : r.status === 'historical' ? 'historical' : 'plan', path: r.path,
      ...(r.source_key ? { docSourceKey: r.source_key } : {}) },
  } }));
}

/** Keep a source's harness/ambient fence in SQL, including on vector legs. */
export function createPlanSearchSource(audience: KnowledgeAudience = {}): SearchSource {
  const filter = (p: SearchSourceParams) => p.sql`
    p.workspace_id = ${p.workspaceId} AND p.template_slug IS NULL
    ${audience.draftItems ? p.sql`AND p.status = 'draft' AND p.archived = false AND p.superseded_by IS NULL` : p.sql``}
    AND (${p.scopeFilter}::text IS NULL OR p.harness_slug = ${p.scopeFilter})
    AND (${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[] IS NULL
      OR p.harness_slug = ANY(${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[]))
    AND NOT (('plan:' || p.harness_slug || ':' || p.plan_slug) = ANY(${[...(audience.excludedRefs ?? [])]}::text[]))
    ${audience.automatic ? p.sql`AND p.archived = false AND p.status IS DISTINCT FROM 'superseded'
      AND p.superseded_by IS NULL` : p.sql``}`;
  const map = (rows: Array<Record<string, unknown>>, ranker: string): Listing => {
    if (audience.draftItems) return rows.flatMap(r => {
      const harness = String(r.harness_slug), slug = String(r.plan_slug);
      const items: unknown[] = Array.isArray(r.items) ? r.items : [];
      return items.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.status !== 'string') return [];
        return [{ key: `plan:${harness}:${slug}#${item.id}`, score: Number(r.rank), row: {
          source: 'plan', source_id: `${harness}:${slug}#${item.id}`, scope: harness,
          excerpt: item.text, highlight: item.text, score: Number(r.rank), rankers: [ranker],
          meta: { title: item.text, planTitle: String(r.title ?? slug), status: 'draft', planSlug: slug,
            itemId: item.id, itemStatus: item.status,
            path: `/admin/plans?plan=${encodeURIComponent(slug)}&harness=${encodeURIComponent(harness)}` },
        } }];
      });
    });
    return listing(rows.map(r => {
    const harness = String(r.harness_slug), slug = String(r.plan_slug);
    const matched = sectionExcerpt(String(r.content ?? ''), String(r.highlight ?? ''));
    const content = r.match_content == null ? matched.content : String(r.match_content);
    const fullText = typeof r.content === 'string' ? `${String(r.title ?? slug)}\n${r.content}` : null;
    const section = r.match_content != null
      ? lastMarkdownHeading(content) ?? (r.section_prefix ? lastMarkdownHeading(String(r.section_prefix)) : null)
      : matched.section;
    return { source_id: `${harness}:${slug}`, title: String(r.title ?? slug), content,
      contextUnit: fullText === null ? null : completeContextUnit(fullText),
      contextSourceVersion: fullText === null || typeof r.workspace_id !== 'string' ? null : JSON.stringify(contextSourceVersion({
        namespace: `corpus:plan:${r.workspace_id}`, ref: `plan:${harness}:${slug}`, fullText,
        revision: null, updatedAt: r.updated_at == null ? null : new Date(r.updated_at as string | Date).toISOString(),
        validity: { status: r.superseded_by || r.status === 'superseded' ? 'superseded' : 'current',
          validAt: null, invalidAt: null, supersededBy: typeof r.superseded_by === 'string' ? r.superseded_by : null },
      })),
      highlight: String(r.highlight ?? content), scope: `harness:${harness}`, rank: Number(r.rank),
      section, status: r.archived || r.superseded_by || r.status === 'superseded' ? 'historical' : String(r.status),
      updated_at: r.updated_at as string | Date,
      path: `/admin/plans?plan=${encodeURIComponent(slug)}&harness=${encodeURIComponent(harness)}` };
    }), 'plan', ranker);
  };
  return boundedSource({
    name: 'plan',
    async lexical(p) {
      const leg = await lexicalLeg(p.sql, {
        table: 'harness_plans', alias: 'p', query: p.query,
        legacy: {
          score: p.sql`ts_rank_cd(p._search, plainto_tsquery('english', ${p.query}))`,
          match: p.sql`p._search @@ plainto_tsquery('english', ${p.query})`,
        },
      });
      if (audience.draftItems) {
        // Reuse the plan index for candidates and the structured item text
        // for relevance, so matching P-NNNs compete in the existing ranker.
        const text = p.sql`to_tsvector('english', item->>'text')`;
        const query = p.sql`plainto_tsquery('english', ${p.query})`;
        const rows = await p.sql`SELECT p.plan_slug, p.harness_slug, p.title,
            jsonb_build_array(item) AS items, ts_rank_cd(${text}, ${query})::float8 AS rank
          FROM harness_shared.harness_plans p
          CROSS JOIN LATERAL jsonb_array_elements(p.items) item
          WHERE ${filter(p)} AND ${leg.match} AND ${text} @@ ${query}
          ORDER BY rank DESC, p.plan_slug, item->>'id' LIMIT ${p.limit}`;
        return map(rows as Array<Record<string, unknown>>, 'lexical');
      }
      const rows = await p.sql`SELECT p.workspace_id, p.plan_slug, p.harness_slug, p.title, p.status, p.archived, p.superseded_by, p.updated_at, p.content,
        (${leg.score})::float8 AS rank,
        ts_headline('english', p.content, ${headlineTsQuery(p.sql, leg.engine, p.query)},
          'StartSel=<mark>,StopSel=</mark>,MaxWords=90,MinWords=30,MaxFragments=1') AS highlight
        FROM harness_shared.harness_plans p WHERE ${filter(p)}
          AND ${leg.match}
        ORDER BY ${leg.order}, p.plan_slug LIMIT ${p.limit}`;
      if (leg.engine !== 'bm25') return map(rows as Array<Record<string, unknown>>, 'lexical');

      // D-016: a bounded legacy AND list protects long plans from BM25's OR-only
      // fragment loss. Reuse its GIN-backed cap and interleaver; keep the same
      // workspace, harness, template, audience, exclusion and currentness fences.
      const exactTop = boundedExactTopK(p.sql as unknown as Sql, {
        columns: p.sql`p.workspace_id, p.harness_slug, p.plan_slug`,
        from: p.sql`harness_shared.harness_plans p`, where: filter(p),
        tsv: p.sql`p._search`, query: p.query, limit: p.limit,
      });
      const exactRows = await p.sql`
        SELECT p.workspace_id, p.plan_slug, p.harness_slug, p.title, p.status, p.archived,
               p.superseded_by, p.updated_at, p.content, e.exact_rank::float8 AS rank,
               ts_headline('english', p.content, ${headlineTsQuery(p.sql, 'legacy', p.query)},
                 'StartSel=<mark>,StopSel=</mark>,MaxWords=90,MinWords=30,MaxFragments=1') AS highlight
          FROM (${exactTop}) e
          JOIN harness_shared.harness_plans p
            USING (workspace_id, harness_slug, plan_slug)
         WHERE ${filter(p)}
      ORDER BY e.exact_rank DESC`;
      const fused = mergeExactAndBm25(
        exactRows as unknown as Array<Record<string, unknown> & { rank: number }>,
        rows as unknown as Array<Record<string, unknown> & { rank: number }>,
        r => `${String(r.workspace_id)}\u0000${String(r.harness_slug)}\u0000${String(r.plan_slug)}`,
        p.limit,
      );
      return map(fused, 'lexical');
    },
    async embedding(p) {
      if (!p.embeddingProfile) return [];
      const space = (profile: string | null, mode: string | null) => profile && mode
        ? PROSE_EMBEDDING_SPACE.sourceFilterSql(p, profile, mode) : p.sql`FALSE`;
      const best = chunkAwareVectorLegSql(p.sql, { surface: PLANS_CHUNK_SURFACE, qVec: p.qVec!,
        limit: p.limit, mode: 'retrieve', parentFilter: filter(p),
        spaceFilter: cols => space(cols.profileColumn, cols.modeColumn) });
      const rows = await p.sql`WITH best AS (${best})
        SELECT p.workspace_id, p.plan_slug, p.harness_slug, p.title, p.content, p.status, p.archived, p.superseded_by, p.updated_at,
          ${audience.draftItems ? p.sql`p.items` : p.sql`NULL::jsonb`} AS items,
          1 - b.distance AS rank, coalesce(c.content, left(p.content, 1500)) AS match_content,
          CASE WHEN c.chunk_idx IS NULL THEN NULL
            ELSE left(p.content, ${planWindowMidpoint(0)} + c.chunk_idx * ${planWindowMidpoint(1) - planWindowMidpoint(0)}) END AS section_prefix
        FROM best b JOIN harness_shared.harness_plans p
          ON p.workspace_id = b.workspace_id AND p.harness_slug = b.harness_slug AND p.plan_slug = b.plan_slug
        LEFT JOIN LATERAL (SELECT c.content, c.chunk_idx FROM harness_shared.text_chunks c
          WHERE c.surface = 'plans' AND c.parent_key = ARRAY[p.workspace_id,p.harness_slug,p.plan_slug]
            AND c.embedding IS NOT NULL AND ${space('c.embedding_profile', 'c.embedding_mode')}
            AND abs((c.embedding <=> ${p.qVec}::vector) + ${PLANS_CHUNK_SURFACE.chunkMargin ?? 0} - b.distance) < 0.000001
          ORDER BY c.embedding <=> ${p.qVec}::vector, c.chunk_idx LIMIT 1) c ON true
        ORDER BY b.distance, p.plan_slug`;
      return map(rows as Array<Record<string, unknown>>, 'embeddings');
    },
  });
}

/** doc_sections is a derived search cache, scoped by the source key.
 * Framework docs are shared; harness docs require workspace membership. */
export function createDocSearchSource(audience: KnowledgeAudience = {}): SearchSource {
  const filter = (p: SearchSourceParams) => p.sql`
    (s.source_key = 'papercusp-engineering' OR EXISTS (
      SELECT 1 FROM harness_shared.harness_registry h,
        jsonb_array_elements(h.payload->'projects') project
      WHERE h.workspace_id = ${p.workspaceId} AND s.source_key = 'harness:' || (project->>'slug')
        AND (${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[] IS NULL
          OR (project->>'slug') = ANY(${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[]))))
    AND (${p.scopeFilter}::text IS NULL OR s.source_key = 'harness:' || ${p.scopeFilter}
      OR (${p.scopeFilter} = 'papercusp' AND s.source_key = 'papercusp-engineering'))
    AND NOT (('doc:' || s.source_key || ':' || s.slug) = ANY(${[...(audience.excludedRefs ?? [])]}::text[]))
    AND NOT EXISTS (SELECT 1 FROM harness_shared.harness_docs d
      WHERE d.workspace_id = ${p.workspaceId}
        AND d.harness_slug = CASE WHEN s.source_key = 'papercusp-engineering' THEN 'papercusp'
          ELSE substring(s.source_key from 9) END
        AND d.doc_id IN (s.slug || '.mdx',s.slug || '.md') AND d.retired_at IS NOT NULL)
    ${audience.automatic ? p.sql`AND s.slug NOT LIKE 'plans/%' AND s.slug NOT LIKE 'reference/plans-%'` : p.sql``}`;
  const map = async (rows: Array<Record<string, unknown>>, ranker: string, p: SearchSourceParams) => {
    if (!rows.length) return [];
    // Refresh only the authorized candidates, using this request's connection
    // and workspace. Section/page hashes describe a projection, not the source.
    const harnessOf = (key: string) => key === 'papercusp-engineering' ? 'papercusp' : key.slice('harness:'.length);
    const harnesses = [...new Set(rows.map(r => harnessOf(String(r.source_key))))];
    const ids = [...new Set(rows.flatMap(r => [String(r.slug), `${r.slug}.mdx`, `${r.slug}.md`]))];
    const canonical = await p.sql`SELECT harness_slug, doc_id, content, content_mode, updated_at, retired_at
      FROM harness_shared.harness_docs WHERE workspace_id = ${p.workspaceId}
        AND harness_slug = ANY(${harnesses}::text[]) AND doc_id = ANY(${ids}::text[])`;
    const records = new Map(canonical.map(r => [`${r.harness_slug}\u0000${r.doc_id}`, r]));
    const mapped = await Promise.all(rows.map(async r => {
    const key = String(r.source_key), slug = String(r.slug), anchor = sectionAnchorBase(String(r.anchor));
    const current = ranker === 'lexical' ? sectionExcerpt(String(r.content),String(r.highlight ?? ''),100).content : String(r.content);
    const content = `${r.previous_context ? `${r.previous_context}\n` : ''}${current}`;
    const harness = harnessOf(key);
    const candidates = [slug, `${slug}.mdx`, `${slug}.md`].map(id => records.get(`${harness}\u0000${id}`)).filter(r => r != null);
    // Retirement wins even when an old alias still has content. Composed rows
    // are caches of doc parts: neither those bytes nor a file projection may
    // masquerade as their canonical authored source.
    if (candidates.some(row => row.retired_at != null)) return null;
    const record = candidates.find(row => row.content_mode === 'composed') ??
      candidates.find(row => typeof row.content === 'string' && row.content.length > 0);
    let raw: string | null = record?.content_mode === 'authored' && typeof record.content === 'string'
      ? record.content : null;
    if (!candidates.length) raw = await fileDocSource(p.sql, p.workspaceId, key, slug, p.signal);
    return { source_id: `${key}:${slug}`, title: String(r.title), content,
      contextUnit: raw === null ? null : completeContextUnit(raw),
      contextSourceVersion: raw === null ? null : JSON.stringify(contextSourceVersion({
        namespace: `corpus:${candidates.length ? 'doc' : 'doc-file'}:${p.workspaceId}`, ref: `doc:${key}:${slug}`, fullText: raw,
        revision: null, updatedAt: record?.updated_at == null ? null : new Date(record.updated_at).toISOString(),
        validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null },
      })),
      highlight: content, scope: key === 'papercusp-engineering' ? 'operator' : key,
      rank: Number(r.rank), section: anchor || null, status: 'maintained', updated_at: r.updated_at as string | Date,
      path: String(r.url) + (anchor ? `#${anchor}` : ''), source_key: key };
    }));
    return listing(mapped.filter((row): row is NonNullable<typeof row> => row !== null), 'doc', ranker);
  };
  /**
   * Keep enough nearest sections for document de-duplication while preserving
   * an ANN-compatible ORDER BY. The old query deduped the whole filtered
   * corpus before ranking, which forced a primary-key scan and sort even
   * though doc_sections has an HNSW index on embedding. Four times the source
   * page is the same bounded over-fetch used by the outer search engine; the
   * final DISTINCT ON still chooses one best section per document.
   */
  const embeddingCandidateLimit = (limit: number): number => Math.max(1, Math.ceil(limit * 4));
  return boundedSource({
    name: 'doc',
    async lexical(p) {
      const rows = await p.sql`SELECT * FROM (SELECT DISTINCT ON (s.source_key,s.slug) s.*,
        ts_rank_cd(to_tsvector('english', s.title || E'\n' || s.content), plainto_tsquery('english', ${p.query})) AS rank,
        ts_headline('english',s.content,plainto_tsquery('english',${p.query}),
          'StartSel=<mark>,StopSel=</mark>,MaxWords=90,MinWords=30,MaxFragments=1') AS highlight,
        (SELECT right(prev.content,250) FROM harness_shared.doc_sections prev
          WHERE prev.source_key = s.source_key AND prev.slug = s.slug
            AND s.section_idx > 0 AND prev.section_idx = s.section_idx - 1 LIMIT 1) AS previous_context
        FROM harness_shared.doc_sections s WHERE ${filter(p)}
          AND to_tsvector('english', s.title || E'\n' || s.content) @@ plainto_tsquery('english', ${p.query})
        ORDER BY s.source_key,s.slug,rank DESC,s.anchor) best
        ORDER BY rank DESC,source_key,slug LIMIT ${p.limit}`;
      return map(rows as Array<Record<string, unknown>>, 'lexical', p);
    },
    async embedding(p) {
      if (!p.embeddingProfile) return [];
      const candidateLimit = embeddingCandidateLimit(p.limit);
      const rows = await p.sql`WITH candidates AS MATERIALIZED (
          SELECT s.*, s.embedding <=> ${p.qVec}::vector AS distance
          FROM harness_shared.doc_sections s
          WHERE ${filter(p)} AND s.embedding IS NOT NULL
            AND ${PROSE_EMBEDDING_SPACE.sourceFilterSql(p, 's.embedding_profile', 's.embedding_mode')}
          ORDER BY s.embedding <=> ${p.qVec}::vector
          LIMIT ${candidateLimit}
        ), best AS (
          SELECT DISTINCT ON (source_key,slug) candidates.*,
            1 - distance AS rank
          FROM candidates
          ORDER BY source_key,slug,distance,anchor
        )
        SELECT best.*,
          (SELECT right(prev.content,250) FROM harness_shared.doc_sections prev
            WHERE prev.source_key = best.source_key AND prev.slug = best.slug
              AND best.section_idx > 0 AND prev.section_idx = best.section_idx - 1 LIMIT 1) AS previous_context
        FROM best
        ORDER BY rank DESC,source_key,slug LIMIT ${p.limit}`;
      return map(rows as Array<Record<string, unknown>>, 'embeddings', p);
    },
  });
}

