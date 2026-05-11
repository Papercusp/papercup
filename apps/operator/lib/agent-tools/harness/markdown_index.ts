/**
 * harness:markdown_index — load the markdown-heading index for every
 * harness in the workspace (filename + heading id + heading text).
 *
 * Used by the operator prompt assembly to give the LLM resolvable
 * anchor ids (papercusp://harness/<slug>/<file>#<anchor>) without
 * having to derive slugs from heading text.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessMarkdownIndex } from '@/lib/harness-markdown-index';

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

export default defineTool({
  name: 'harness:markdown_index',
  description: 'Load the per-harness markdown index (filename + headings + anchor ids) across the workspace.',
  guidance: {
    when: 'User asks "what docs exist?", "where\'s the spec for X?", or you need to navigate to a specific section of the harness\'s markdown.',
    notWhen: 'For the doc CONTENT, use `artifacts:load` once you have the path. For wiki-style backlinks (`[[name]]` references), use `wiki:backlinks`.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const index = await loadHarnessMarkdownIndex();
    return { content: [{ type: 'text', text: JSON.stringify({ index }) }] };
  },
});
