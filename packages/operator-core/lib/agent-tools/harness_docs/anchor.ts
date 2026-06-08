/**
 * harness_docs:anchor — declare/refresh a MANUAL doc's drift anchor (P-006). The
 * doc says what code it documents (subject_ref) via the `documents` arg, its
 * `documents:` frontmatter, or inference from the paths it references. Optionally
 * verify it against HEAD now. An unanchored manual doc stays allowed but visibly
 * "not drift-tracked".
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessScope, harnessArg } from '../_harness-scope';
import { anchorManualDoc } from '../../harness/docs/manual-anchor';

const argsSchema = z.object({
  harness: harnessArg,
  docId: z.string().min(1).describe("The manual doc's path relative to the docs root, e.g. 'guides/setup.md'."),
  documents: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('What this doc documents: feature ids (F-3), file globs (src/**), or symbols (src/a.ts :: fn). Omit to read the doc\'s `documents:` frontmatter / infer from the paths it references.'),
  verify: z.boolean().optional().describe('Also stamp the verify baseline to the current HEAD (you confirm the doc is current now).'),
  title: z.string().optional(),
});

export default defineTool({
  name: 'harness_docs:anchor',
  description:
    'Anchor a manual doc to the code it documents (its subject_ref) so drift is tracked; optionally verify it against HEAD. Unanchored manual docs remain allowed but flagged "not drift-tracked".',
  guidance: {
    when: 'A human-authored doc should be drift-tracked: declare what code it covers. Run after writing/editing the doc, or to fix a wrong anchor.',
    notWhen: 'For a generated doc use harness_docs:record (it sets a generated baseline). To only re-confirm currency use harness_docs:verify.',
    chaining: 'harness_docs:anchor { documents } → (later, on a drift nudge) harness_docs:verify.',
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
    const res = await anchorManualDoc({
      harnessSlug: scope.slug,
      docId: args.docId,
      ...(args.documents !== undefined ? { documents: args.documents } : {}),
      ...(args.verify !== undefined ? { verify: args.verify } : {}),
      ...(args.title ? { title: args.title } : {}),
    });
    if (!res.ok) return { content: [{ type: 'text' as const, text: JSON.stringify(res) }], isError: true };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, docId: res.record.docId, source: res.record.source, status: res.record.status, anchored: res.anchored, subjectRef: res.subjectRef }) }],
    };
  },
});
