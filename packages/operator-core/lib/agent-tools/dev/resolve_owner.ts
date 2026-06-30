/**
 * dev:resolve_owner — resolve a coordination owner id to its session(s).
 *
 * WI-1279. Given an agent owner id (the `from` field on plan-events /
 * coord:presence / coord:whoami's ownerId — su-… interactive SU, s-… fleet bee,
 * pus-… power-user), return the session(s) it ran in: the native resume
 * session_id (claude/codex — what you pass to `claude --resume`), omp_thread_id
 * (omp), the spawn/run ids, plan, cwd, and the per-turn telemetry activity
 * attributed to that owner. Closes the owner→session gap dev:sessions has.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveOwnerSessions } from '../../dev-data';

export default defineTool({
  name: 'dev:resolve_owner',
  profile: 'engineer',
  description:
    'Resolve a coordination owner id (su-…/s-…/pus-…) to its session(s): the native resume session_id (claude/codex), omp_thread_id, spawn/run ids, plan, cwd, and per-turn telemetry activity. The owner↔session link the dev:sessions list lacks.',
  capability: 'intel:read',
  guidance: {
    when: `You have an agent OWNER id (from coord:presence, a plan-event's \`from\`, or coord:whoami) and need the session it ran in — e.g. the id to pass to \`claude --resume\`.`,
    notWhen: `You already have a spawn_id — use \`dev:session_detail\`. For the session LIST, use \`dev:sessions\`.`,
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'bee'],
  args: z.object({
    ownerId: z.string().min(1),
  }),
  async handler(args) {
    const result = await resolveOwnerSessions(args.ownerId);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
