/**
 * roles:list — list role manifests for a harness (or globally if no slug).
 *
 * Wraps `listRoles()` from apps/operator/lib/role-registry.ts. Useful
 * for agents introspecting which roles they can spawn into.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listRoles } from '../../role-registry';

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
  name: 'roles:list',
  profile: 'engineer',
  guidance: {
    when: 'You need the set of agent roles configured in the workspace (architect, worker, validator, …) before spawning or dispatching.',
    notWhen: 'For agents currently RUNNING, use `agents:list`. roles:list is the static configuration; agents:list is the live processes.',
    chaining: 'Pair with `roles:get` for one role\'s definition.',
  },
  description: 'List role manifests (id, source, fires-on, etc.) for a harness, or globally when no harness given.',
  capability: 'roles:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
  }),
  async handler(args, ctx) {
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    const roles = listRoles(slug);
    return { content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug || null, roles }) }] };
  },
});
