/**
 * memory:forget — delete a memory by id.
 *
 * Brain calls when user says "forget X" or contradicts a stored fact.
 * Always informs the user out loud ("Removing that from memory").
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryClient } from '../../memory/mem0-client';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'memory:forget',
  capability: 'memory:write',
  description: 'Delete a specific memory entry by id.',
  guidance: {
    when:
      'When the user explicitly says "forget X" / "don\'t remember that anymore" / "that\'s wrong, drop it". Always inform the user out loud ("Removed that from memory").',
    notWhen:
      'To CORRECT a memory (replace its content), use memory:update — preserves history. Only use forget for outright removal.',
  },
  requirePrincipal: true, // auth-gated: principal required (unauthed HTTP → 401)
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.object({
    id: z.string().min(1),
  }),
  async handler(args) {
    const client = await getMemoryClient();
    if (!client) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'mem0_unavailable' }) }],
      };
    }
    await client.delete(args.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    };
  },
});
