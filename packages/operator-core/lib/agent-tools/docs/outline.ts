/**
 * docs:outline — context-aware doc outline.
 *
 * Resolves the source by caller context:
 *   - ctx.harnessSlug set → that harness's docs (the harnessFsAdapter)
 *   - otherwise          → Papercusp engineering reference
 *                          (starlightContentAdapter against operator-docs/src/content/docs)
 *
 * Same tool, same shape — the agent doesn't need to learn two surfaces.
 * Workers/scopers in a harness get their harness's docs; SU and
 * operator/oracle/documenter agents working on Papercusp itself get
 * the framework engineering reference. Cross-harness lookups (an
 * engineer wanting harness X's docs from outside) use
 * cross_harness:docs_outline.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  buildOutline,
  genericFsAdapter,
  harnessFsAdapter,
  RunCache,
  type DocSource,
  type OutlinePayload,
} from '@papercusp/docs-engine';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { engineeringAdapter } from './_engineering-adapter';
import { HARNESS_REQUIRED_DETAIL, resolveHarnessScope } from '../_harness-scope';

const cache = new RunCache<OutlinePayload>();

export async function resolveAdapter(
  harnessSlug: string | undefined,
  opts: { isSuperuser?: boolean } = {},
): Promise<{
  adapter: DocSource;
  scope: string;
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
        scope: '_project',
        surface: 'project',
      };
    }
    // D-005 / P-016: engineering branch is for papercusp-su (SU/engineer) only.
    if (opts.isSuperuser) {
      return { adapter: engineeringAdapter, scope: '_engineering', surface: 'engineering' };
    }
    // Non-SU caller with no project docs — don't leak Papercusp's docs.
    return {
      adapter: engineeringAdapter, // placeholder; handler bails on `error`
      scope: '_none',
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
      scope: '_engineering',
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  return {
    adapter: harnessFsAdapter(resolveHarnessContentPath(reg, harnessSlug) ?? project.path, {
      name: `harness:${harnessSlug}`,
    }),
    scope: harnessSlug,
    surface: 'harness',
  };
}

export default defineTool({
  name: 'docs:outline',
  description:
    'Return the documentation table-of-contents for your context — your harness\'s docs (in a harness), your project\'s docs (PAPERCUSP_PROJECT_DOCS_ROOT env var), or the Papercusp framework engineering reference (papercusp-su callers only). Cached per run. Call this FIRST when you need design context; drill in via docs:get.',
  guidance: {
    when: 'You need design context, architectural rationale, or "how does X work" answers and have not yet called docs:outline this run.',
    notWhen:
      'You already called docs:outline this run — cached. For prose recall (chats, escalations, brainstorms) use search:fulltext. To explore another harness from outside, use cross_harness:docs_outline.',
    chaining:
      'docs:outline → docs:get { slugs: [...] }. Use { slug, heading } when only one section of a long page is relevant.',
  },
  capability: 'docs:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    harness: z
      .string()
      .optional()
      .describe(
        "Harness slug whose docs outline to return. Pass 'all' for Papercusp's own framework docs / your project docs (operator scope). " +
          "Omit only when the session is already scoped to a harness — otherwise you'll get harness_required.",
      ),
  }),
  async handler(args, ctx) {
    const ctxAny = ctx as {
      runId?: string;
      spawnId?: string;
      harnessSlug?: string;
      isSuperuser?: boolean;
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
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

    const hit = cache.get(ctxAny, resolved.scope);
    if (hit) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...hit, cached: true, surface: resolved.surface }) }],
      };
    }
    const payload = await buildOutline(resolved.adapter, {
      ...(ctxAny.runId !== undefined && { runId: ctxAny.runId }),
      ...(ctxAny.spawnId !== undefined && { spawnId: ctxAny.spawnId }),
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    cache.set(ctxAny, payload, resolved.scope);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, cached: false, surface: resolved.surface }) }],
    };
  },
});

