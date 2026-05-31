/**
 * coord:whoami — return the coordination identity the server resolved
 * for the caller. Debug aid: confirm how the coordination layer (L1)
 * sees this agent before relying on lock-ownership / message-sender
 * behaviour.
 *
 * agent-coordination-architecture-v2 §4.3.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:whoami',
  description:
    'Return the coordination identity the server resolved for you: ownerId (the stable per-agent id), ownerLabel, source, workspaceId, userId. A debug aid for confirming how the coordination layer sees this agent.',
  guidance: {
    when: 'Debugging identity — "what ownerId am I?" before relying on lock or message behaviour.',
    notWhen: 'Routine work — identity is resolved automatically by every coord:* and locks:* call.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(identity) },
      ],
    };
  },
});
