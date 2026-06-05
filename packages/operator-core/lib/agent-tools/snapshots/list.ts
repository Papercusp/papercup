/**
 * snapshots:list — enumerate every published snapshot known to the
 * workspace registry. 5-second TTL cache lives in the underlying
 * `listAllSnapshots()` so repeated calls are cheap.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { listAllSnapshots } from '../../snapshot-discovery';
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
  name: 'snapshots:list',
  profile: 'engineer',
  guidance: {
    when: 'User asks "what snapshots do I have?", "any backups?". Cross-harness snapshot enumeration.',
    notWhen: 'For ONE snapshot\'s detail, use `snapshots:get`. For automated backups (not snapshots), check backup-group tools.',
    chaining: 'Pair with `snapshots:get` for content.',
  },
  description: 'List every published snapshot known to the workspace registry (id, slug, version, …).',
  capability: 'snapshots:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const enabled = await getFlag(FLAGS.SNAPSHOTS, resolveDistinctId(new Request('http://localhost/')));
    if (!enabled) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: false, reason: 'feature-disabled', flag: FLAGS.SNAPSHOTS }) },
        ],
        isError: true,
      };
    }
    const snapshots = await listAllSnapshots();
    return { content: [{ type: 'text', text: JSON.stringify({ snapshots }) }] };
  },
});
