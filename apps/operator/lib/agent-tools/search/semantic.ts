/**
 * Plan 2B+C — semantic recall + hybrid (BM25 + embeddings via RRF).
 *
 * `search:semantic` queries the same 3 prose surfaces as
 * `search:fulltext` but uses cosine similarity on pre-computed
 * embeddings (migration 061 + lib/search/embed-backfill.ts). When
 * `mode='hybrid'` it runs both BM25 and embeddings, then combines via
 * Reciprocal Rank Fusion:
 *
 *     score(d) = Σ  1 / (k + rank_i(d))
 *
 * with k=60 (the canonical value). RRF doesn't need to normalize
 * scores between rankers, which matters here because tsvector
 * ts_rank_cd and cosine similarity live in totally different scales.
 *
 * If pgvector isn't installed OR backfill hasn't populated embeddings,
 * mode='embeddings' returns empty and mode='hybrid' falls back to
 * BM25-only (silently — log via ctx.log).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { rrfCombine, RRF_K_DEFAULT } from './rrf';

const SCOPE_CHOICES = ['escalations', 'brainstorm', 'turns', 'all'] as const;
const MODE_CHOICES = ['embeddings', 'hybrid'] as const;

interface SemanticHit {
  source: string;
  source_id: string;
  harness_slug?: string;
  excerpt: string;
  highlight: string;
  /** RRF score when hybrid, raw cosine when embeddings, raw rank_cd when bm25. */
  score: number;
  /** Which rankers contributed (for debugging). */
  rankers: string[];
}

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

const HEADLINE_OPTS =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=18, MinWords=5, ShortWord=2';
const EMBEDDER_DIM = 384;
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const LOCAL_EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';

type ResolvedMode = 'openai' | 'local';

async function buildQueryEmbedder(): Promise<((t: string) => Promise<number[]>) | null> {
  // Same cascade mem0 uses, but lazy. Returns null if no embedder is
  // available — caller falls back to BM25-only.
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const { readCredentials } = await import('../../credentials');
    const creds = await readCredentials();
    if (creds.openai_api_key) key = creds.openai_api_key;
  } catch {
    /* env fallback */
  }
  let mode: ResolvedMode | null = null;
  try {
    const { loadVoicePrefs } = await import('../../voice-prefs');
    const prefs = await loadVoicePrefs();
    const m = (prefs as Record<string, unknown>).memoryEmbedderMode;
    if (m === 'openai' && key) mode = 'openai';
    else if (m === 'local') mode = 'local';
    else if (m === 'auto' || !m) {
      if (key) mode = 'openai';
      else mode = 'local';
    }
  } catch {
    if (key) mode = 'openai';
  }
  if (mode === 'openai' && key) {
    return async (text: string) => {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: OPENAI_EMBEDDER_MODEL,
          input: text,
          dimensions: EMBEDDER_DIM,
        }),
      });
      if (!r.ok) throw new Error(`openai_embed_${r.status}`);
      const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
      return j.data[0].embedding;
    };
  }
  if (mode === 'local') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicImport = new Function('s', 'return import(s)') as any;
      const transformers = await dynamicImport('@huggingface/transformers');
      const pipe = await transformers.pipeline('feature-extraction', LOCAL_EMBEDDER_MODEL);
      return async (text: string) => {
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(result.data) as number[];
      };
    } catch {
      return null;
    }
  }
  return null;
}

export default defineTool({
  name: 'search:semantic',
  capability: 'search:read',
  description:
    'Semantic recall over workspace prose using embedding similarity. mode=hybrid combines with BM25 (search:fulltext) via Reciprocal Rank Fusion for best of both keyword and meaning. Falls back to BM25 if embeddings unavailable.',
  guidance: {
    when:
      'User asks about a concept by paraphrase rather than the exact keyword used in the recorded text. Examples: "when did we talk about authentication strategy" (could match "login flow", "auth approach", "JWT decision"). Prefer mode=hybrid for best recall.',
    notWhen:
      'When the user knows the exact keyword they want. `search:fulltext` is faster + cheaper there (no embedding API call). For structured queries (tasks/goals/projects rows by title), use `search:query`.',
    chaining:
      'Pair with `harness:escalation` or `harness:plan_reviews` to fetch the full row of a hit.',
  },
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 8 }, operator: { perRun: 50 } },
  args: z.object({
    query: z.string().min(1).max(500),
    scope: z.array(z.enum(SCOPE_CHOICES)).optional(),
    harness_slug: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    mode: z.enum(MODE_CHOICES).optional(),
  }),
  async handler(args, ctx) {
    const limit = args.limit ?? 5;
    const mode = args.mode ?? 'hybrid';
    const scope = args.scope?.includes('all') || !args.scope?.length
      ? ['escalations', 'brainstorm', 'turns']
      : args.scope;
    const harnessFilter = args.harness_slug ?? null;

    const embedQuery = await buildQueryEmbedder();
    let queryVec: number[] | null = null;
    if (embedQuery) {
      try { queryVec = await embedQuery(args.query); } catch (err) {
        ctx.log?.(`search:semantic query embed failed: ${(err as Error).message}`);
      }
    }

    // Per-source ranked lists. Each list is an ordered array of
    // (source_id → metadata). We materialize them then fuse.
    type Listing = Array<{ key: string; score: number; row: SemanticHit }>;
    const bmListings: Record<string, Listing> = {};
    const embListings: Record<string, Listing> = {};

    // ── BM25 ────────────────────────────────────────────────────────
    if (mode === 'hybrid') {
      if (scope.includes('escalations')) {
        try {
          const rows = (await ctx.tx`
            SELECT harness_slug, phase, escalation, supervisor_notes,
                   ts_rank_cd(body_tsv, plainto_tsquery('english', ${args.query})) AS rank,
                   ts_headline('english',
                     COALESCE(escalation, '') || E'\n' || COALESCE(supervisor_notes, ''),
                     plainto_tsquery('english', ${args.query}),
                     ${HEADLINE_OPTS}
                   ) AS highlight
              FROM harness_shared.harness_escalations
             WHERE workspace_id = ${ctx.workspaceId}
               AND (${harnessFilter}::text IS NULL OR harness_slug = ${harnessFilter})
               AND body_tsv @@ plainto_tsquery('english', ${args.query})
          ORDER BY rank DESC LIMIT ${limit * 3}
          `) as unknown as Array<{ harness_slug: string; phase: string; escalation: string|null; supervisor_notes: string|null; rank: number; highlight: string }>;
          bmListings.escalations = rows.map((r) => {
            const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
            const key = `escalations:${r.harness_slug}:${r.phase}`;
            return {
              key, score: r.rank, row: {
                source: 'escalations',
                source_id: `${r.harness_slug}:${r.phase}`,
                harness_slug: r.harness_slug,
                excerpt: body.slice(0, 200) + (body.length > 200 ? '…' : ''),
                highlight: r.highlight, score: r.rank, rankers: ['bm25'],
              },
            };
          });
        } catch (err) { ctx.log?.(`bm25 esc skipped: ${(err as Error).message}`); }
      }
      if (scope.includes('brainstorm')) {
        try {
          const rows = (await ctx.tx`
            SELECT harness_slug, phase, content,
                   ts_rank_cd(content_tsv, plainto_tsquery('english', ${args.query})) AS rank,
                   ts_headline('english', content,
                     plainto_tsquery('english', ${args.query}),
                     ${HEADLINE_OPTS}) AS highlight
              FROM harness_shared.harness_brainstorm
             WHERE workspace_id = ${ctx.workspaceId}
               AND (${harnessFilter}::text IS NULL OR harness_slug = ${harnessFilter})
               AND content_tsv @@ plainto_tsquery('english', ${args.query})
          ORDER BY rank DESC LIMIT ${limit * 3}
          `) as unknown as Array<{ harness_slug: string; phase: string; content: string; rank: number; highlight: string }>;
          bmListings.brainstorm = rows.map((r) => {
            const key = `brainstorm:${r.harness_slug}:${r.phase}`;
            return {
              key, score: r.rank, row: {
                source: 'brainstorm',
                source_id: `${r.harness_slug}:${r.phase}`,
                harness_slug: r.harness_slug,
                excerpt: r.content.slice(0, 200) + (r.content.length > 200 ? '…' : ''),
                highlight: r.highlight, score: r.rank, rankers: ['bm25'],
              },
            };
          });
        } catch (err) { ctx.log?.(`bm25 brn skipped: ${(err as Error).message}`); }
      }
      if (scope.includes('turns')) {
        try {
          const rows = (await ctx.tx`
            SELECT t.id, t.role, t.text,
                   ts_rank_cd(t.text_tsv, plainto_tsquery('english', ${args.query})) AS rank,
                   ts_headline('english', t.text,
                     plainto_tsquery('english', ${args.query}),
                     ${HEADLINE_OPTS}) AS highlight
              FROM harness_shared.operator_turns t
              JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
             WHERE c.workspace_id = ${ctx.workspaceId}
               AND t.text_tsv @@ plainto_tsquery('english', ${args.query})
          ORDER BY rank DESC LIMIT ${limit * 3}
          `) as unknown as Array<{ id: string; role: string; text: string; rank: number; highlight: string }>;
          bmListings.turns = rows.map((r) => {
            const key = `turns:${r.id}`;
            return {
              key, score: r.rank, row: {
                source: 'turns', source_id: r.id,
                excerpt: `[${r.role}] ${r.text.slice(0, 200)}${r.text.length > 200 ? '…' : ''}`,
                highlight: `[${r.role}] ${r.highlight}`,
                score: r.rank, rankers: ['bm25'],
              },
            };
          });
        } catch (err) { ctx.log?.(`bm25 turns skipped: ${(err as Error).message}`); }
      }
    }

    // ── Embeddings ──────────────────────────────────────────────────
    if (queryVec) {
      const qVec = `[${queryVec.join(',')}]`;
      if (scope.includes('escalations')) {
        try {
          const rows = (await ctx.tx`
            SELECT harness_slug, phase, escalation, supervisor_notes,
                   1 - (body_embedding <=> ${qVec}::vector) AS sim,
                   ts_headline('english',
                     COALESCE(escalation, '') || E'\n' || COALESCE(supervisor_notes, ''),
                     plainto_tsquery('english', ${args.query}),
                     ${HEADLINE_OPTS}) AS highlight
              FROM harness_shared.harness_escalations
             WHERE workspace_id = ${ctx.workspaceId}
               AND (${harnessFilter}::text IS NULL OR harness_slug = ${harnessFilter})
               AND body_embedding IS NOT NULL
          ORDER BY body_embedding <=> ${qVec}::vector
             LIMIT ${limit * 3}
          `) as unknown as Array<{ harness_slug: string; phase: string; escalation: string|null; supervisor_notes: string|null; sim: number; highlight: string }>;
          embListings.escalations = rows.map((r) => {
            const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
            const key = `escalations:${r.harness_slug}:${r.phase}`;
            return {
              key, score: r.sim, row: {
                source: 'escalations',
                source_id: `${r.harness_slug}:${r.phase}`,
                harness_slug: r.harness_slug,
                excerpt: body.slice(0, 200) + (body.length > 200 ? '…' : ''),
                highlight: r.highlight, score: r.sim, rankers: ['embeddings'],
              },
            };
          });
        } catch (err) { ctx.log?.(`embed esc skipped: ${(err as Error).message}`); }
      }
      if (scope.includes('brainstorm')) {
        try {
          const rows = (await ctx.tx`
            SELECT harness_slug, phase, content,
                   1 - (content_embedding <=> ${qVec}::vector) AS sim,
                   ts_headline('english', content,
                     plainto_tsquery('english', ${args.query}),
                     ${HEADLINE_OPTS}) AS highlight
              FROM harness_shared.harness_brainstorm
             WHERE workspace_id = ${ctx.workspaceId}
               AND (${harnessFilter}::text IS NULL OR harness_slug = ${harnessFilter})
               AND content_embedding IS NOT NULL
          ORDER BY content_embedding <=> ${qVec}::vector
             LIMIT ${limit * 3}
          `) as unknown as Array<{ harness_slug: string; phase: string; content: string; sim: number; highlight: string }>;
          embListings.brainstorm = rows.map((r) => {
            const key = `brainstorm:${r.harness_slug}:${r.phase}`;
            return {
              key, score: r.sim, row: {
                source: 'brainstorm',
                source_id: `${r.harness_slug}:${r.phase}`,
                harness_slug: r.harness_slug,
                excerpt: r.content.slice(0, 200) + (r.content.length > 200 ? '…' : ''),
                highlight: r.highlight, score: r.sim, rankers: ['embeddings'],
              },
            };
          });
        } catch (err) { ctx.log?.(`embed brn skipped: ${(err as Error).message}`); }
      }
      if (scope.includes('turns')) {
        try {
          const rows = (await ctx.tx`
            SELECT t.id, t.role, t.text,
                   1 - (t.text_embedding <=> ${qVec}::vector) AS sim,
                   ts_headline('english', t.text,
                     plainto_tsquery('english', ${args.query}),
                     ${HEADLINE_OPTS}) AS highlight
              FROM harness_shared.operator_turns t
              JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
             WHERE c.workspace_id = ${ctx.workspaceId}
               AND t.text_embedding IS NOT NULL
          ORDER BY t.text_embedding <=> ${qVec}::vector
             LIMIT ${limit * 3}
          `) as unknown as Array<{ id: string; role: string; text: string; sim: number; highlight: string }>;
          embListings.turns = rows.map((r) => {
            const key = `turns:${r.id}`;
            return {
              key, score: r.sim, row: {
                source: 'turns', source_id: r.id,
                excerpt: `[${r.role}] ${r.text.slice(0, 200)}${r.text.length > 200 ? '…' : ''}`,
                highlight: `[${r.role}] ${r.highlight}`,
                score: r.sim, rankers: ['embeddings'],
              },
            };
          });
        } catch (err) { ctx.log?.(`embed turns skipped: ${(err as Error).message}`); }
      }
    }

    // ── Combine via RRF (pure, see ./rrf.ts) ────────────────────────
    const inputs: Array<{ name: string; list: Listing }> = [];
    if (mode === 'hybrid') {
      for (const list of Object.values(bmListings)) inputs.push({ name: 'bm25', list });
      for (const list of Object.values(embListings)) inputs.push({ name: 'embeddings', list });
    } else {
      for (const list of Object.values(embListings)) inputs.push({ name: 'embeddings', list });
    }
    const fused = rrfCombine(inputs, RRF_K_DEFAULT);
    const results = fused.slice(0, limit).map(({ row, score, rankers }) => ({
      ...row, score, rankers,
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: args.query,
          mode,
          embedder_available: !!queryVec,
          scope,
          total_hits: fused.length,
          results,
        }),
      }],
    };
  },
});
