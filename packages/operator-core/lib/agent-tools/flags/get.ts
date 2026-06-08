/**
 * flags:get - resolve a single Papercusp feature flag.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveDistinctId } from '../../flag-distinct-id';
import './_register-backend';

const FlagKeySchema = z.enum(ALL_FLAG_KEYS as unknown as [FlagKey, ...FlagKey[]]);

export default defineTool({
  name: 'flags:get',
  profile: 'engineer',
  description:
    'Resolve one Papercusp feature flag to a boolean for this host.',
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'bee'],
  args: z.object({
    key: FlagKeySchema,
  }),
  async handler(args) {
    const fakeReq = new Request('http://localhost/agent-tool');
    const enabled = await getFlag(args.key, resolveDistinctId(fakeReq));
    return {
      content: [
        { type: 'text', text: JSON.stringify({ key: args.key, enabled }, null, 2) },
      ],
    };
  },
});
