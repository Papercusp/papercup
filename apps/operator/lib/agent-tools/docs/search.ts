/**
 * docs:search — keyword search across public Papercusp docs.
 *
 * Thin wrapper around @papercusp/docs-engine's searchDocs. Title ×4,
 * description ×2, body ×1; ranked hits with slug, url, title,
 * description, score, excerpt around the first match.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { searchDocs, fumadocsAdapter } from '@papercusp/docs-engine';
import { source } from '@/lib/source';

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

const argsSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('Keyword query. Whitespace-separated tokens; tokens <2 chars dropped.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe('Max hits returned. Default 8.'),
});

// Use the base fumadocs adapter (no preamble) — search wants the body
// matched cheaply; preamble adds noise.
const adapter = fumadocsAdapter(source as never, { name: 'papercusp-public' });

export default defineTool({
  name: 'docs:search',
  description:
    'Keyword search across public Papercusp documentation. Returns ranked hits (slug, title, description, excerpt). Use when you have a specific term in mind; prefer docs:outline for browsing.',
  guidance: {
    when: 'You have specific terminology in mind (a function name, concept, or component) and want to find which doc page covers it. Faster than scanning the outline when the section name is non-obvious.',
    notWhen:
      'You do not know what to search for — call docs:outline first. For PG-stored prose recall (escalations, chats) use search:fulltext. For per-harness docs use harness:docs_outline.',
    chaining:
      'docs:search → docs:get { slugs: [top-hit] } (or { slug, heading } if the hit excerpt names a specific heading).',
  },
  capability: 'docs:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  modality: ['text'],
  rolesQuota: {
    worker: { perChunk: 8 },
    operator: { perRun: 20 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      signal?: AbortSignal;
      metadata?: (data: Record<string, unknown>) => void;
      progress?: (pct: number, msg: string) => void;
    };
    const response = await searchDocs(adapter, args, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
      ...(ctxAny.progress && { progress: ctxAny.progress }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
  },
});
