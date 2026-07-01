/**
 * docs:get — context-aware doc page fetch.
 *
 * Same routing as docs:outline: harness-context callers get their
 * harness's docs; everyone else gets Papercusp engineering reference.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  genericFsAdapter,
  getDocs,
  harnessFsAdapter,
  withPreamble,
  type DocSource,
} from '@papercusp/docs-engine';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { engineeringAdapter as engineeringBase } from './_engineering-adapter';
import { HARNESS_REQUIRED_DETAIL, resolveHarnessScope } from '../_harness-scope';

function wrapWithPreamble(base: DocSource): DocSource {
  return {
    ...base,
    async getContent(page) {
      const body = await base.getContent(page);
      return withPreamble(body, {
        title: page.title,
        url: page.url,
        ...(page.description ? { description: page.description } : {}),
      });
    },
  };
}

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
        adapter: wrapWithPreamble(genericFsAdapter(projectDocsRoot, { name: 'project' })),
        surface: 'project',
      };
    }
    // D-005 / P-016: engineering branch is for papercusp-su (SU/engineer) only.
    if (opts.isSuperuser) {
      return { adapter: wrapWithPreamble(engineeringBase), surface: 'engineering' };
    }
    return {
      adapter: wrapWithPreamble(engineeringBase),
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
      adapter: wrapWithPreamble(engineeringBase),
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  return {
    adapter: wrapWithPreamble(
      harnessFsAdapter(resolveHarnessContentPath(reg, harnessSlug) ?? project.path, {
        name: `harness:${harnessSlug}`,
      }),
    ),
    surface: 'harness',
  };
}

const argsSchema = z
  .object({
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe('1–10 slugs from docs:outline.pages[].slug (e.g. ["endpoint-system/overview"]).'),
    heading: z
      .string()
      .optional()
      .describe('Heading anchor id (from docs:outline.pages[].headings[].id). Only honored when slugs.length === 1.'),
    harness: z
      .string()
      .optional()
      .describe(
        "Harness slug whose docs to read. Pass 'all' for Papercusp's own framework docs / your project docs (operator scope). " +
          "Omit only when the session is already scoped to a harness — otherwise you'll get harness_required.",
      ),
  })
  .refine((v) => !v.heading || v.slugs.length === 1, {
    message: 'heading is only valid when slugs has exactly one entry',
    path: ['heading'],
  });

export default defineTool({
  name: 'docs:get',
  description:
    "Fetch documentation pages by slug — your harness's docs (in a harness), your project's docs (PAPERCUSP_PROJECT_DOCS_ROOT env var), or the Papercusp framework reference (papercusp-su callers only). Batch up to 10; pass `heading` (single-slug only) for a section slice. Per-slug error envelope.",
  guidance: {
    when: 'You have slugs from docs:outline and need page contents. Use `heading` (single-slug) when only one section of a long page is relevant.',
    notWhen:
      'You do not yet know the slug — call docs:outline first. To fetch another harness\'s docs from outside, use cross_harness:docs_get.',
    chaining:
      'docs:outline → docs:get { slugs } (batch up to 10) → optionally re-fetch with { slugs: [picked], heading } for surgical reads.',
    seeAlso: [
      'docs:outline (find slugs to read)',
      'docs:search (locate the right page by term first)',
    ],
  },
  capability: 'docs:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  rolesQuota: {
    worker: { perChunk: 10 },
    operator: { perRun: 15 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
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

    const response = await getDocs(resolved.adapter, args, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...response, surface: resolved.surface }) }] };
  },
});

