/**
 * harness_docs:list — the merged per-harness docs tree (P-007), agent-facing.
 * Generated + manual + augmented docs with source + freshness status + (for the
 * active doc) the body + augmented overlay. Same data the docs tab renders.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessScope, harnessArg } from '../_harness-scope';
import { buildMergedDocs } from '../../harness/docs/merged-read';
import { shapeHarnessDocsList } from './list-shape';

const argsSchema = z.object({
  harness: harnessArg,
  docId: z.string().optional().describe('Which doc to load the body/overlay for (defaults to index/README/first).'),
  recompute: z.boolean().optional().describe('Recompute the active doc\'s freshness from git on read (default: use the cached sweep status).'),
});

export default defineTool({
  name: 'harness_docs:list',
  description:
    'List a harness\'s merged docs (generated · manual · augmented) with source badges + drift status (fresh/stale/review/untracked), and the active doc\'s body + augmented overlay. Supersedes the FS-only project-docs read.',
  guidance: {
    when: 'You want a harness\'s project docs WITH provenance + freshness — which are generated vs human, which are stale, which are not drift-tracked.',
    notWhen: 'For Papercusp framework docs use docs:get/outline. For raw markdown without metadata the old project-docs endpoint still exists but is superseded.',
    chaining: 'harness_docs:list → harness_docs:regenerate (stale generated) / harness_docs:verify (stale manual) / harness_docs:set_overlay (add human nuance).',
    seeAlso: [
      'harness_docs:regenerate (refresh a stale GENERATED doc)',
      'harness_docs:verify (re-confirm a stale MANUAL doc)',
      'docs:outline (Papercusp FRAMEWORK docs live in the docs:* surface)',
    ],
  },
  capability: 'docs:read',
  requirePrincipal: false,
  agentRoles: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'documenter', 'doc-steward', 'curator', 'operator'],
  modality: ['text'],
  args: argsSchema,
  // context-trimming-tiers P-023: trimmed/standard sessions get lean entry
  // rows, a clipped active-doc body with a loud continuation pointer, and the
  // `files` duplicate collapsed to a count (see list-shape.ts).
  // EI-8326: a caller that supplied `docId` wants a compact per-doc status,
  // not the whole harness's global entries list re-sent every time.
  shape: {
    standard: (data, sctx) =>
      shapeHarnessDocsList(data, 'standard', { docIdRequested: !!(sctx.args as { docId?: string }).docId }),
    trimmed: (data, sctx) =>
      shapeHarnessDocsList(data, 'trimmed', { docIdRequested: !!(sctx.args as { docId?: string }).docId }),
  },
  async handler(args, ctx) {
    const scope = resolveHarnessScope(args.harness, ctx as { harnessSlug?: string });
    if (scope.kind !== 'harness') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }], isError: true };
    }
    const merged = await buildMergedDocs(scope.slug, {
      ...(args.docId ? { activePath: args.docId } : {}),
      ...(args.recompute ? { recomputeActive: true } : {}),
    });
    // {data} envelope so the payload-tier shapers apply (the error path above
    // stays a raw ToolResult and passes through unshaped).
    return { data: merged };
  },
});
