/**
 * harness_docs:set_overlay — attach/replace/clear the human AUGMENTED overlay on a
 * doc (P-005 / D-003). The overlay (intent, caveats, the "why") rides on top of a
 * generated body and SURVIVES regeneration. Setting an overlay makes the doc
 * `augmented`; clearing it reverts to generated/manual.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessScope, harnessArg } from '../_harness-scope';
import { getDocRecord, setDocOverlay, upsertDocRecord } from '../../harness/docs/doc-record';

const argsSchema = z.object({
  harness: harnessArg,
  docId: z.string().min(1).describe("The doc's path relative to the docs root."),
  overlay: z.string().describe('The human overlay markdown (intent / caveats / the "why"). Pass an empty string to CLEAR the overlay.'),
});

export default defineTool({
  name: 'harness_docs:set_overlay',
  description: 'Attach a human "augmented" overlay to a doc — nuance that rides on top of the generated body and survives regeneration. Empty string clears it.',
  guidance: {
    when: 'A generated doc is accurate but missing the human "why"/caveats you want preserved across regenerations. Add it as an overlay rather than hand-editing the generated body (which a regen would lose).',
    notWhen: 'To change the generated body itself, fix the code/feature and regenerate. For a fully human doc, author it as a manual doc.',
    chaining: 'harness_docs:list → harness_docs:set_overlay { overlay }.',
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'operator', 'worker', 'architect', 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const scope = resolveHarnessScope(args.harness, ctx as { harnessSlug?: string });
    if (scope.kind !== 'harness') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }], isError: true };
    }
    const docId = args.docId.trim().replace(/^\.?\//, '');
    const overlay = args.overlay.trim() === '' ? null : args.overlay;
    // Ensure a record exists (overlaying a doc that was never recorded — e.g. an
    // unanchored manual file — creates a minimal manual record first).
    const existing = await getDocRecord(scope.slug, docId);
    if (!existing) {
      await upsertDocRecord({ harnessSlug: scope.slug, docId, source: 'manual', subjectRef: [], anchorPaths: [], status: 'untracked' });
    }
    await setDocOverlay(scope.slug, docId, overlay);
    const updated = await getDocRecord(scope.slug, docId);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, docId, source: updated?.source, hasOverlay: !!(updated?.overlay && updated.overlay.trim()) }) }] };
  },
});
