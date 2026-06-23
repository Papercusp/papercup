/**
 * recipes:search — rank reusable code:run RECIPES by similarity to a query
 * (code-recipes-2026-06-21 Phase 2, P-005), so an agent can dedup-check BEFORE
 * authoring a fresh code:run.
 *
 * Rides the SAME hybrid engine the on-run dedup uses (searchSimilarRecipes,
 * D-009): BM25 over title+description (title_tsv) + pgvector cosine over the
 * embedding, fused via RRF, then blended with a structural tool-set-overlap
 * (Jaccard) signal. Hive-scoped (D-005). Read-only ranked read.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { searchSimilarRecipes } from '../../code-recipes-search';
import { buildQueryEmbedder } from '../search/embedder';

export default defineTool({
  name: 'recipes:search',
  description:
    'Search reusable code:run RECIPES by intent (hybrid BM25 + embedding + tool-set overlap). Use ' +
    'BEFORE authoring a multi-step code:run to find a recipe that already does it. Read-only.',
  guidance: {
    when:
      'BEFORE writing a multi-step code:run — describe what you want to do and this ranks the ' +
      'recipes in your hive that already do something similar (semantic + tool-set match). If a ' +
      'high-similarity recipe fits, recipes:run it instead of re-authoring.',
    notWhen:
      'To browse all recipes most-run-first (recipes:list), or when you already hold the id ' +
      '(recipes:get / recipes:run). code:run still auto-surfaces similarRecipes after the fact — ' +
      'this is the BEFORE-you-author check.',
    chaining:
      'recipes:search { query } → recipes:get { id } (inspect the top hit) → recipes:run { id } (reuse).',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    query: z.string().min(1).max(500).describe('What you want to do — title/description text, free-form.'),
    limit: z.number().int().min(1).max(20).optional().describe('Top-N to return (default 5).'),
  }),
  async handler(args, ctx) {
    const embedder = await buildQueryEmbedder().catch(() => null);
    // The query carries no separate description / tool-set — feed it as the title
    // and let the lexical + cosine legs do the work (toolsUsed empty ⇒ the
    // structural leg contributes 0, so ranking is purely text similarity here).
    const recipes = await searchSimilarRecipes(
      getOrgPg().sql,
      {
        title: args.query,
        description: '',
        toolsUsed: [],
        embedding: null,
        limit: args.limit ?? 5,
      },
      { embedder, log: (msg) => ctx.log(msg) },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, query: args.query, recipes }) }],
    };
  },
});
