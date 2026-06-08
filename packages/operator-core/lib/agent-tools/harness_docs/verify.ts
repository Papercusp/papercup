/**
 * harness_docs:verify — confirm a manual doc is current as of HEAD (P-006 / D-004
 * re-verify action). Sets last_verified_sha = HEAD → fresh, clearing the re-verify
 * flag. The human/agent is asserting the doc matches the code right now.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessScope, harnessArg } from '../_harness-scope';
import { verifyManualDoc } from '../../harness/docs/manual-anchor';

const argsSchema = z.object({
  harness: harnessArg,
  docId: z.string().min(1).describe("The doc's path relative to the docs root."),
});

export default defineTool({
  name: 'harness_docs:verify',
  description: "Re-verify a manual doc: stamp its drift baseline to the current HEAD and mark it fresh. Use after reviewing a doc the freshness sweep flagged for re-verify.",
  guidance: {
    when: 'A manual doc was flagged for re-verify (its subject code changed) and you confirmed it\'s still accurate — or you just edited it to match.',
    notWhen: 'For a generated doc use harness_docs:regenerate. To set the anchor in the first place use harness_docs:anchor.',
    chaining: 'harness_docs:list (find review docs) → read → harness_docs:verify.',
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'operator', 'worker', 'architect', 'reviewer', 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const scope = resolveHarnessScope(args.harness, ctx as { harnessSlug?: string });
    if (scope.kind !== 'harness') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }], isError: true };
    }
    const res = await verifyManualDoc(scope.slug, args.docId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }], ...(res.ok ? {} : { isError: true }) };
  },
});
