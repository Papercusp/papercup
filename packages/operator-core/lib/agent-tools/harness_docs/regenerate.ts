/**
 * harness_docs:regenerate — request a documenter regeneration of a stale generated
 * doc (P-007 action / D-004). Enqueues the regeneration (the documenter refreshes
 * the body + re-records provenance); the badge stays stale until that lands.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessScope, harnessArg } from '../_harness-scope';
import { requestRegeneration } from '../../harness/docs/regenerate';

const argsSchema = z.object({
  harness: harnessArg,
  docId: z.string().min(1).describe("The generated doc's path relative to the docs root."),
});

export default defineTool({
  name: 'harness_docs:regenerate',
  description: 'Request a documenter regeneration of a stale generated/augmented doc. Enqueues it (preserving any human overlay); the doc refreshes when the documenter re-records it.',
  guidance: {
    when: 'A generated doc is stale (its subject code changed) and you want it refreshed.',
    notWhen: 'For a manual doc use harness_docs:verify. To preserve human nuance across the regen, add it via harness_docs:set_overlay first.',
    chaining: 'harness_docs:list (find stale generated) → harness_docs:regenerate.',
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'operator', 'reviewer'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const scope = resolveHarnessScope(args.harness, ctx as { harnessSlug?: string });
    if (scope.kind !== 'harness') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }], isError: true };
    }
    const res = await requestRegeneration(scope.slug, args.docId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }], ...(res.ok ? {} : { isError: true }) };
  },
});
