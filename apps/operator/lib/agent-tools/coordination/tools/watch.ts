/**
 * coord:watch — register interest in paths matching a glob.
 *
 * When something matches (lock acquired, plan reference, etc.), the
 * coordination layer drops a `notify` envelope into the watcher's
 * inbox. Auto-firing from locks:acquire / plans:* is a planned future
 * bolt-on; for now, callers fire notifications by hand via the
 * substrate helper (`fireNotifications`).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { addWatch } from '../subscriptions';
import { COORD_ROLES } from '../roles';

const TRIGGER = ['lock_acquired', 'file_edited', 'plan_referenced', 'any'] as const;

export default defineTool({
  name: 'coord:watch',
  description:
    'Register a watch on paths matching a glob. v1 glob: `**` matches anything (incl. /), `*` matches anything except /. Returns the watch msg_id — pass it to coord:unwatch to cancel.',
  guidance: {
    when: 'You want to know when anyone else touches a region of code you care about. Useful before starting a refactor.',
    notWhen: 'Once-off check — use coord:presence + locks:queue. Watches are best for ongoing situational awareness.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pattern: z.string().min(1),
    trigger: z.enum(TRIGGER).optional(),
    ttl_sec: z.number().int().positive().optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const w = await addWatch(identity, {
      pattern: args.pattern,
      trigger: args.trigger,
      ttl_sec: args.ttl_sec,
    });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, watch: w }) },
      ],
    };
  },
});
