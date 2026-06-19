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
} from '@papercusp/docs-engine';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { engineeringAdapter } from './_engineering-adapter';
import { HARNESS_REQUIRED_DETAIL, resolveHarnessScope } from '../_harness-scope';

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
      "Harness slug whose docs to search. Pass 'all' for Papercusp's own framework docs / your project docs (operator scope). " +
        "Omit only when the session is already scoped to a harness — otherwise you'll get harness_required.",
    ),
});

export default defineTool({
  name: 'docs:search',
  description:
    "Keyword search across your context's documentation — your harness's docs (in a harness), your project's docs (PAPERCUSP_PROJECT_DOCS_ROOT env var), or the Papercusp framework reference (papercusp-su callers only). Returns ranked hits (slug, title, description, excerpt).",
  guidance: {
    when: 'You have specific terminology in mind (a function name, concept, or component) and want to find which doc page covers it. Faster than scanning the outline when the section name is non-obvious.',
    notWhen:
      'You do not know what to search for — call docs:outline first. For PG-stored prose (chats, escalations) use search:fulltext. To search another harness from outside, use cross_harness:docs_search.',
    chaining:
      'docs:search → docs:get { slugs: [top-hit] } (or { slug, heading } if the hit excerpt names a specific heading).',
  },
  capability: 'docs:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
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
    ctxAny.metadata?.({ surface: resolved.surface, ...(scope.kind === 'harness' ? { harness_slug: scope.slug } : {}) });

    const response = await searchDocs(resolved.adapter, args, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
      ...(ctxAny.progress && { progress: ctxAny.progress }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...response, surface: resolved.surface }) }] };
  },
});
