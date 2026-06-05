/**
 * memory:forget — delete a memory by id.
 *
 * Brain calls when user says "forget X" or contradicts a stored fact.
 * Always informs the user out loud ("Removing that from memory").
 * Storage rides the neutral `MemoryBackend` seam.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend } from '../../memory/backend';

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
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason }) }],
      };
    }
    await backend.forget(args.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    };
  },
});
