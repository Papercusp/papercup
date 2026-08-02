/**
 * docs:search — context-aware keyword search.
 *
 * Same routing as docs:outline: harness-context callers get their
 * harness's docs; everyone else gets Papercusp engineering reference.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  genericFsAdapter,
  searchDocs,
  harnessFsAdapter,
  type DocSource,
  type SearchHit,
} from '@papercusp/docs-engine';
import { rrfCombine, RRF_K_DEFAULT, type RankedItem } from '@papercusp/rrf';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { engineeringAdapter } from './_engineering-adapter';
import { HARNESS_REQUIRED_DETAIL, isEngineeringDocsSentinel, resolveHarnessScope, type HarnessScope } from '../_harness-scope';
import { semanticDocHits } from './semantic-leg';

export async function resolveAdapter(
  harnessSlug: string | undefined,
  opts: { isSuperuser?: boolean } = {},
): Promise<{
  adapter: DocSource;
  surface: 'harness' | 'engineering' | 'project';
  error?: { code: string; slug?: string; detail?: string };
}> {
  // SU mode passes harnessSlug='*' as a wildcard sentinel (set by
  // http-projection.ts when an admin calls with ?superuser=1 and no harness).
  // Treat it the same as "no harness" so the project/engineering branch is
  // reached — matching plans/source.ts, plans/_ctx-opts.ts, projects/list.ts.
  // Without this, '*' falls through to the registry lookup and returns a
  // bogus harness_not_registered{slug:'*'} for every SU/engineer caller.
  if (!harnessSlug || harnessSlug === '*') {
    // D-001 / P-004: project-docs branch via env var (set by omp-su wrapper).
    const projectDocsRoot = process.env.PAPERCUSP_PROJECT_DOCS_ROOT?.trim();
    if (projectDocsRoot) {
      return {
        adapter: genericFsAdapter(projectDocsRoot, { name: 'project' }),
        surface: 'project',
      };
    }
    // D-005 / P-016: engineering branch is for papercusp-su (SU/engineer) only.
    if (opts.isSuperuser) {
      return { adapter: engineeringAdapter, surface: 'engineering' };
    }
    return {
      adapter: engineeringAdapter,
      surface: 'engineering',
      error: {
        code: 'no_docs_source',
        detail:
          'No harness in context, PAPERCUSP_PROJECT_DOCS_ROOT not set, and caller is not papercusp-su. Set PAPERCUSP_PROJECT_DOCS_ROOT to point at your project docs.',
      },
    };
  }
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (!project) {
    return {
      adapter: engineeringAdapter,
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  return {
    adapter: harnessFsAdapter(resolveHarnessContentPath(reg, harnessSlug) ?? project.path, {
      name: `harness:${harnessSlug}`,
    }),
    surface: 'harness',
  };
}

const argsSchema = z.object({
  query: z.string().min(2).max(200).describe('Keyword query. Whitespace-separated tokens; tokens <2 chars dropped.'),
  limit: z.number().int().min(1).max(20).default(8).describe('Max hits returned. Default 8.'),
  harness: z
    .string()
    .optional()
    .describe(
      "Harness slug whose docs to search. Pass 'all' for Papercusp's own framework docs / your project docs (operator scope) — " +
        "but only on an UNSCOPED (--all-workspaces) session; a workspace-scoped su session gets harness_forbidden and must " +
        "name a concrete harness instead (EI-12898). Omit only when the session is already scoped to a harness — otherwise you'll get harness_required.",
    ),
  semantic: z
    .boolean()
    .optional()
    .describe(
      'Merge embedding-cosine hits after the lexical results (up to 3 extras, marked semantic:true). ' +
        'Default on (off under vitest); false = lexical-only.',
    ),
});

export default defineTool({
  name: 'docs:search',
  description:
    "Keyword search across your context's documentation — your harness's docs (in a harness), your project's docs (PAPERCUSP_PROJECT_DOCS_ROOT env var), or the Papercusp framework reference (papercusp-su callers only). Returns ranked hits (slug, title, description, excerpt). A harness/project-scoped call does NOT include agent-insights/ or the framework docs (a separate `harness:'all'` surface) — a weak result carries a `scopeNote` saying so; don't read it as \"no such page\".",
  guidance: {
    when: 'You have specific terminology in mind (a function name, concept, or component) and want to find which doc page covers it. Faster than scanning the outline when the section name is non-obvious.',
    notWhen:
      'You do not know what to search for — call docs:outline first. For PG-stored prose (chats, escalations) use search:fulltext. To search another harness from outside, use cross_harness:docs_search.',
    chaining:
      'docs:search → docs:get { slugs: [top-hit] } (or { slug, heading } if the hit excerpt names a specific heading).',
    seeAlso: [
      'docs:outline (browse the full section tree when the term is unknown)',
      'docs:get (read a matched page)',
    ],
  },
  capability: 'docs:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup-deep'],
  modality: ['text'],
  rolesQuota: {
    worker: { perChunk: 8 },
    operator: { perRun: 20 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      harnessSlug?: string;
      isSuperuser?: boolean;
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
      progress?: (pct: number, msg: string) => void;
    };
    const scope = resolveHarnessScope(args.harness, ctxAny);
    if (scope.kind === 'none') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'harness_required', detail: HARNESS_REQUIRED_DETAIL }) }],
        isError: true,
      };
    }
    const effectiveSlug = scope.kind === 'all' ? '*' : scope.slug;
    const resolved = await resolveAdapter(effectiveSlug, { isSuperuser: ctxAny.isSuperuser });
    if (resolved.error) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: resolved.error.code, slug: resolved.error.slug }) },
        ],
        isError: true,
      };
    }
    const limit = args.limit;
    // WI-5690 (sibling of WI-5683's plans:search fix): over-fetch the LEXICAL
    // leg past `limit` so RRF fusion below has real headroom to promote a
    // semantic-only hit above the cut — mirrors the semantic leg's own
    // OVERFETCH pattern (semantic-leg.ts) and plans/search.ts's `limit*3`
    // over-fetch. searchDocs's internal `hitCount`/full `scored` list is
    // unaffected by the limit param; only how much of it gets sliced into
    // `hits` changes, so this is purely more fusion candidates, not a
    // behavior change to the underlying ranker.
    const overFetchLimit = Math.max(limit * 3, 30);

    // searchDocs's own ctx.metadata call reports non_searchable_excluded
    // (not part of its return value) — capture it via a local sink instead of
    // forwarding ctxAny.metadata directly, so it can be merged into ONE final
    // metadata() call below that reflects the POST-fusion counts rather than
    // the over-fetched intermediate ones.
    let innerMeta: Record<string, unknown> = {};
    const response = await searchDocs(resolved.adapter, { ...args, limit: overFetchLimit }, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.progress && { progress: ctxAny.progress }),
      metadata: (d) => { innerMeta = d; },
    });

    // WI-5690: fuse the lexical ranking with the migration-552 doc-section
    // semantic ranking via Reciprocal Rank Fusion (@papercusp/rrf, same
    // pattern plans:search / search:semantic already use) instead of scoring
    // lexical-only and APPENDING up to 3 semantic extras after the cut. RRF
    // combines by RANK POSITION, not raw score, so a page that ranks #1
    // semantically (a rephrased query whose words never appear verbatim in
    // the answer doc) can't be buried behind — or dropped entirely by the
    // `limit`-capped slice ahead of — pages that only win on raw lexical
    // score. Strictly fail-open: an embedder outage/timeout/disable degrades
    // to lexical-only (matches the prior default-on behavior); inert under
    // vitest unless semantic:true is forced (WI-3792 load-scar class).
    let semanticHitCount = 0;
    let finalHits: Array<SearchHit & { semantic?: true; similarity?: number; anchor?: string }>;
    const semanticOn = args.semantic ?? !process.env.VITEST;
    let sem: Awaited<ReturnType<typeof semanticDocHits>> = null;
    if (semanticOn) {
      try {
        sem = await semanticDocHits(args.query, resolved.adapter.name, overFetchLimit);
      } catch {
        // fail-open: the lexical result stands.
        sem = null;
      }
    }

    if (sem?.length) {
      const lexicalSlugs = new Set(response.hits.map((h) => h.slug));
      const lexicalRanked: RankedItem<SearchHit>[] = response.hits.map((h) => ({ key: h.slug, score: h.score, row: h }));
      const semanticRanked: RankedItem<SearchHit>[] = sem.map((h) => ({
        key: h.slug,
        score: h.similarity,
        row: { slug: h.slug, url: h.url, title: h.title, score: 0, excerpt: h.excerpt },
      }));
      const simBySlug = new Map(sem.map((h) => [h.slug, Math.round(h.similarity * 1000) / 1000]));
      const anchorBySlug = new Map(sem.map((h) => [h.slug, h.anchor]));
      const fused = rrfCombine<SearchHit>(
        [
          { name: 'lexical', list: lexicalRanked },
          { name: 'semantic', list: semanticRanked },
        ],
        RRF_K_DEFAULT,
      );
      finalHits = fused.slice(0, limit).map(({ row, rankers }) => {
        const similarity = simBySlug.get(row.slug);
        const anchor = anchorBySlug.get(row.slug);
        // Only mark semantic:true (the "this wasn't a lexical match" signal
        // downstream callers key on) when the page has NO lexical hit of its
        // own — a page found by both legs keeps its real lexical excerpt and
        // just also carries the similarity that helped rank it.
        if (!lexicalSlugs.has(row.slug) && rankers.includes('semantic')) {
          semanticHitCount += 1;
          return { ...row, semantic: true as const, similarity, ...(anchor ? { anchor } : {}) };
        }
        return similarity !== undefined ? { ...row, similarity } : row;
      });
    } else {
      finalHits = response.hits.slice(0, limit);
    }

    // EI-18804433041289369: `surface` alone is easy to skim past — a caller who names their OWN
    // harness (the natural, seemingly-correct thing to pass) gets a scoped project-docs/harness-docs
    // corpus that does NOT include agent-insights/ or the framework reference, and a plausible-looking
    // ranked result (even a NON-empty one — the reported incident had 37 hits, just from the wrong
    // corpus) reads as "no such page exists" rather than "wrong corpus". Say so explicitly on every
    // non-engineering-surface response, so a weak/absent-feeling result is legible as SCOPE, not absence.
    const scopeNote =
      resolved.surface === 'engineering'
        ? undefined
        : `This '${resolved.surface}' surface (${resolved.adapter.name}) does NOT include agent-insights/ or the Papercusp framework reference — those live on the separate 'engineering' surface. A weak or zero-looking result here does not mean no such page exists; retry with harness:'all' before concluding that.`;

    const payload: Record<string, unknown> = {
      ...response,
      hits: finalHits,
      hitCount: response.hitCount,
      surface: resolved.surface,
      ...(scope.kind === 'harness' ? { harness_slug: scope.slug } : {}),
      ...(semanticHitCount > 0 ? { semanticHitCount } : {}),
      ...(scopeNote ? { scopeNote } : {}),
    };
    ctxAny.metadata?.({
      ...innerMeta,
      surface: resolved.surface,
      ...(scope.kind === 'harness' ? { harness_slug: scope.slug } : {}),
      returned: finalHits.length - semanticHitCount,
      ...(semanticHitCount > 0 ? { semanticHitCount } : {}),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
