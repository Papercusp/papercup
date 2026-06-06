/**
 * harness_docs:record — the documenter stamps a generated doc's provenance
 * (P-004 / D-001). After writing docs/features/F-<id>.md the documenter calls this
 * with the feature + files/symbols it read; the server resolves the harness repo's
 * HEAD as generated_from_sha, resolves the anchor paths, and upserts the typed doc
 * record. Provenance is a byproduct of generation, not reverse-engineered.
 *
 * Idempotent + overlay-safe: re-recording (a regeneration) advances the baseline
 * and preserves any human augmented overlay (D-003/P-005).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessScope, harnessArg } from '../_harness-scope';
import { recordGeneratedDoc } from '../../harness/docs/provenance';

const argsSchema = z.object({
  harness: harnessArg,
  docId: z
    .string()
    .min(1)
    .describe(
      "The generated doc's path RELATIVE TO THE DOCS ROOT, e.g. 'features/F-3.md' — the same path it appears under in the docs tab.",
    ),
  documents: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'What this doc documents (its drift anchor). A list (or comma-form string) of: feature ids (F-3 / WI-12), file globs (src/foo.ts, packages/x/**), or symbols (src/foo.ts :: myFn). Capture exactly the files/symbols you read to write the doc. Omit only for a features/F-NNN.md doc (the feature is inferred from the filename).',
    ),
  title: z.string().optional().describe('Optional human title for list rendering.'),
});

export default defineTool({
  name: 'harness_docs:record',
  description:
    "Record a generated doc's provenance + drift anchor (subject_ref) and stamp it generated-from the harness repo's current HEAD. Call this once per generated doc immediately after writing the file, passing what you read.",
  guidance: {
    when: 'You (the documenter) just wrote or refreshed a generated doc file (docs/features/F-<id>.md, a guide). Call once per doc with the feature + the exact files/symbols you read.',
    notWhen:
      'For a human-authored manual doc, use harness_docs:anchor instead (it sets a verify baseline, not a generated baseline). Do not call for docs you only read.',
    chaining: 'Write the .md file → harness_docs:record { docId, documents }. The freshness sweep then tracks it against future commits.',
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'operator'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const scope = resolveHarnessScope(args.harness, ctx as { harnessSlug?: string });
    if (scope.kind !== 'harness') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }],
        isError: true,
      };
    }
    const result = await recordGeneratedDoc({
      harnessSlug: scope.slug,
      docId: args.docId,
      documents: args.documents,
      ...(args.title ? { title: args.title } : {}),
    });
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            docId: result.record.docId,
            source: result.record.source,
            status: result.record.status,
            generatedFromSha: result.generatedFromSha,
            subjectRef: result.subjectRef,
            anchorPaths: result.anchorPaths,
          }),
        },
      ],
    };
  },
});
