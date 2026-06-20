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
import { inboxWakeKey } from '../inbox-wake';

export default defineTool({
  name: 'coord:whoami',
  description:
    'Return the coordination identity the server resolved for you: ownerId (the stable per-agent id), ownerLabel, source, workspaceId, userId, and your inbox_wake_key (the key a coord:send {wake:true} fires + the one coord:await-inbox watches). A debug aid for confirming how the coordination layer sees this agent.',
  guidance: {
    when: 'Debugging identity — "what ownerId am I?" before relying on lock or message behaviour.',
    notWhen: 'Routine work — identity is resolved automatically by every coord:* and locks:* call.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    // EI-1748: whoami is the IDENTITY-INTROSPECTION tool — when the server can't
    // resolve an identity (e.g. a superuser/HTTP-bridge request with no ?client=),
    // returning the reason + the fix is far more useful than throwing a structural
    // error. Degrade gracefully into a readable payload instead of a 500-class throw.
    let identity;
    try {
      identity = resolveAgentIdentity(ctx);
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              resolved: false,
              error: err instanceof Error ? err.message : String(err),
              hint:
                'No coordination identity resolved. Calling the superuser MCP endpoint ' +
                'directly (curl/HTTP bridge)? Add ?client=<your-su-id> to the request URL ' +
                '(and workspace=<id> for scoped reads).',
              isSuperuser: ctx.isSuperuser ?? false,
              workspaceId: ctx.workspaceId ?? null,
            }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ...identity, inbox_wake_key: inboxWakeKey(identity.ownerId) }),
        },
      ],
    };
  },
});
