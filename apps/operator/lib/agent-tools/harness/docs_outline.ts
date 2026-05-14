/**
 * harness:docs_outline — outline of THIS harness's documentation.
 *
 * Reads <projectPath>/docs/**\/*.md plus well-known state files
 * (SPEC.md, AGENTS.md, .harness/{knowledge,supervisor-notes,
 * validation-contract}.md) and returns sections + pages + headings.
 *
 * Not to be confused with docs:outline (which reads the public
 * Papercusp framework documentation).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildOutline, harnessFsAdapter, type OutlinePayload } from '@papercusp/docs-engine';
import { loadHarnessRegistry } from '@/lib/harness-registry';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

/** Per-run cache keyed by `<runId|spawnId>:<slug>`. */
export const harnessOutlineCache = new Map<string, OutlinePayload>();
export const CACHE_MAX = 100;

export default defineTool({
  name: 'harness:docs_outline',
  description:
    "Outline of THIS harness's documentation — the docs/ folder plus state files (SPEC.md, AGENTS.md, .harness/knowledge.md, .harness/supervisor-notes.md, .harness/validation-contract.md). For the public Papercusp framework docs, use docs:outline.",
  guidance: {
    when: 'You need to know what documentation exists in THIS harness — feature specs, plans, contracts, AGENTS.md, the SPEC. Call this FIRST when working on harness-internal context.',
    notWhen:
      "For Papercusp framework docs (how the harness system itself works, endpoint-system, plugins, agents), use docs:outline. For PG-stored prose (chats, escalations) use search:fulltext.",
    chaining:
      'harness:docs_outline → harness:docs_get { paths: [...] } for content. Use { path, heading } for surgical reads.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    const ctxAny = ctx as { runId?: string; spawnId?: string; harnessSlug?: string };
    const slug = ctxAny.harnessSlug;
    if (!slug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'no_harness_context', message: 'harness:docs_outline requires a harness context (spawn URL or harnessSlug query param).' }),
          },
        ],
        isError: true,
      };
    }

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'harness_not_registered', slug }),
          },
        ],
        isError: true,
      };
    }

    const key = `${ctxAny.runId ?? ctxAny.spawnId ?? '_anon'}:${slug}`;
    const hit = harnessOutlineCache.get(key);
    if (hit) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...hit, cached: true, harnessSlug: slug }) }],
      };
    }

    const adapter = harnessFsAdapter(project.path, { name: `harness:${slug}` });
    const payload = await buildOutline(adapter);
    // Fix URL placeholder __SLUG__ → real slug.
    const fixed: OutlinePayload = {
      ...payload,
      sections: payload.sections.map((s) => ({
        ...s,
        pages: s.pages.map((p) => p),
      })),
    };

    harnessOutlineCache.set(key, fixed);
    if (harnessOutlineCache.size > CACHE_MAX) {
      const oldest = harnessOutlineCache.keys().next().value;
      if (oldest !== undefined) harnessOutlineCache.delete(oldest);
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...fixed, cached: false, harnessSlug: slug }) }],
    };
  },
});
