/**
 * memory:remember — explicit add to mem0.
 *
 * Brain calls this when the user says "remember X" or when the brain
 * itself notices an error/preference that would recur without
 * persistence. The persona prompt instructs the brain to ALWAYS
 * inform the user out loud ("I'll remember that") — never ask.
 *
 * userId is resolved server-side from the session cookie. Brain does
 * NOT pass it; the route guarantees the memory lands on the right user.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryClient } from '../../memory/mem0-client';
import { getSessionUserOrDefault } from '../../auth';

const KINDS = ['identity', 'preference', 'project', 'correction', 'ephemeral'] as const;

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'memory:remember',
  capability: 'memory:write',
  description:
    'Store a fact about the user into persistent memory. Use one of 5 kinds (identity / preference / project / correction / ephemeral). Per Plan 3.',
  guidance: {
    when:
      'When the user says "remember X" / "don\'t forget Y" / "next time…" / "from now on…", OR when YOU notice an error you made that would recur without persistence. ALWAYS inform the user out loud ("I\'ll remember that").',
    notWhen:
      'For workspace-shared facts that other users should see, do NOT use unless explicitly told the fact is shared. Default scope is per-user.',
    chaining:
      'After writing, the persona prompt will surface this entry on the next turn\'s pre-turn injection. No need to call memory:search to verify.',
  },
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: z.object({
    content: z.string().min(1).max(2000),
    kind: z.enum(KINDS),
    expires_at: z.string().datetime().optional()
      .describe("ISO timestamp. Required for kind='ephemeral'; ignored otherwise. Auto-cleanup runs daily."),
    harness_slug: z.string().optional()
      .describe('If the fact is harness-scoped (e.g. project context), tag it here.'),
    shared: z.boolean().optional()
      .describe('Set true to make this a workspace-shared memory visible to OTHER users in the same workspace.'),
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const client = await getMemoryClient();
    if (!client) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'mem0_unavailable' }) }],
      };
    }
    if (args.kind === 'ephemeral' && !args.expires_at) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'ephemeral_requires_expires_at' }) }],
      };
    }

    const metadata: Record<string, unknown> = {
      kind: args.kind,
      workspace_id: ctx.workspaceId,
      created_by: user.id,
      display_name: user.display_name,
    };
    if (args.expires_at) metadata.expires_at = args.expires_at;
    if (args.harness_slug) metadata.harness_slug = args.harness_slug;
    if (args.shared) metadata.shared = true;

    const result = await client.add(args.content, {
      userId: args.shared ? `workspace:${ctx.workspaceId}` : user.id,
      metadata,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }],
    };
  },
});
