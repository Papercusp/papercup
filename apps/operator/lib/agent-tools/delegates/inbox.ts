/**
 * delegates:inbox — peek/drain/push the delegate inbox.
 *
 * The Hindsight inbox for the EL voice agent: notifications that
 * arrive when no live EL session is connected get stashed here so
 * the next session can deliver them.
 *
 *   - { op: 'peek' }              → { pending } count
 *   - { op: 'drain' }             → { items } and mark delivered
 *   - { op: 'push', headline,
 *       kind?, agentSessionId? } → push one row
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import {
  drainDelegateInbox,
  peekDelegateInbox,
  pushDelegateInbox,
} from '@/lib/delegate-inbox';

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
  name: 'delegates:inbox',
  profile: 'engineer',
  guidance: {
    when: 'User asks "did the delegate finish?", "what did the worker come back with?" — read pending delegate-completion messages.',
    notWhen: 'For YOUR ordinary inbox, use `messages:inbox`. delegates:inbox is the narrow stream of "delegate finished, here\'s the summary" messages.',
  },
  description: 'Peek, drain, or push to the delegate inbox (Hindsight queue for the EL voice agent).',
  capability: 'delegates:write',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 30 }, architect: { perRun: 100 } },
  // Flat object schema (not discriminatedUnion) because OpenAI's
  // function-calling schema validator rejects discriminator-shaped
  // top-level `anyOf` — it requires `type: "object"` at the root. The
  // handler enforces the per-op required fields at runtime.
  args: z.object({
    op: z.enum(['peek', 'drain', 'push']),
    headline: z.string().min(1).optional()
      .describe("Required when op='push'."),
    kind: z.string().optional(),
    agentSessionId: z.string().optional(),
  }),
  async handler(args) {
    const workspaceId = activeWorkspaceId();
    if (args.op === 'peek') {
      const pending = await peekDelegateInbox({ workspaceId });
      return { content: [{ type: 'text', text: JSON.stringify({ pending }) }] };
    }
    if (args.op === 'drain') {
      const items = await drainDelegateInbox({ workspaceId });
      return { content: [{ type: 'text', text: JSON.stringify({ items }) }] };
    }
    // op === 'push'
    if (!args.headline) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'headline is required when op=push' }) }] };
    }
    await pushDelegateInbox({
      workspaceId,
      headline: args.headline,
      kind: args.kind,
      agentSessionId: args.agentSessionId,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  },
});
