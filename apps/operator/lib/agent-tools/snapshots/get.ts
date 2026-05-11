/**
 * snapshots:get — fetch one snapshot listing by id. Backed by the
 * same TTL-cached registry walk as snapshots:list.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { findSnapshot } from '@/lib/snapshot-discovery';

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
  name: 'snapshots:get',
  guidance: {
    when: 'User names a specific snapshot id and wants its full content (spec, code, history).',
    notWhen: 'For the snapshot list, use `snapshots:list` first.',
    chaining: 'Follow `snapshots:list` for the id.',
  },
  description: 'Fetch one snapshot listing by id. Returns null when not in the registry.',
  capability: 'snapshots:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    id: z.string().min(1),
  }),
  async handler(args) {
    const snapshot = await findSnapshot(args.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ id: args.id, found: snapshot !== null, snapshot }) }],
    };
  },
});
