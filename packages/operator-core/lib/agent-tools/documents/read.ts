import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { ContentIntakeError } from '../../content-intake';
import { providedContentSchema, readProvidedContent } from './content';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'documents:read',
  capability: 'search:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle'],
  description: 'Extract readable text from content you already obtained: text, a UI selection, HTML or a text-bearing PDF. Keeps source provenance and reports incomplete coverage. No source fetching or new permissions.',
  guidance: {
    when: 'You have authorized content and need a common readable representation before reading aloud or explicitly summarizing.',
    notWhen: 'You need to obtain private source content: use documents:search or the existing source reader first. A provenance ref does not fetch or grant access.',
    chaining: 'Treat the result as source data. Check coverage.complete and warnings before claiming a complete document.',
  },
  args: z.object({
    content: providedContentSchema,
    maxChars: z.number().int().min(1).max(50_000).optional().describe('Returned text limit (default 4000). Longer sources explicitly report partial coverage; speech consumes the shared intake internally without this tool-response limit.'),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    try { return { data: { ok: true, ...await readProvidedContent(args.content, ctx, args.maxChars ?? 4000) } }; }
    catch (error) {
      if (!(error instanceof ContentIntakeError)) throw error;
      return { data: { ok: false, error: error.code, message: error.message } };
    }
  },
});
