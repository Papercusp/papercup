/**
 * snapshots:get — fetch one snapshot listing by id. Backed by the
 * same TTL-cached registry walk as snapshots:list.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { findSnapshot } from '../../snapshot-discovery';
import { resolveDistinctId } from '../../flag-distinct-id';

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
  profile: 'engineer',
  guidance: {
    when: 'User names a specific snapshot id and wants its full content (spec, code, history).',
    notWhen: 'For the snapshot list, use `snapshots:list` first.',
    chaining: 'Follow `snapshots:list` for the id.',
  },
  description: 'Fetch one snapshot listing by id. Returns null when not in the registry.',
  capability: 'snapshots:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    id: z.string().min(1),
  }),
  async handler(args) {
    const enabled = await getFlag(FLAGS.SNAPSHOTS, resolveDistinctId(new Request('http://localhost/')));
    if (!enabled) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: false, reason: 'feature-disabled', flag: FLAGS.SNAPSHOTS }) },
        ],
        isError: true,
      };
    }
    const snapshot = await findSnapshot(args.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ id: args.id, found: snapshot !== null, snapshot }) }],
    };
  },
});
