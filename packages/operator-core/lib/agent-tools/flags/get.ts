/**
 * flags:get - resolve one OR many Papercusp feature flags for this host.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `key` for one or `keys`
 * for several → { ok, results:[{ ok, key, enabled | error }], counts }. Each
 * result self-describes its key; one unresolvable key never poisons the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveDistinctId } from '../../flag-distinct-id';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import './_register-backend';

const FlagKeySchema = z.enum(ALL_FLAG_KEYS as unknown as [FlagKey, ...FlagKey[]]);

export default defineTool({
  name: 'flags:get',
  profile: 'engineer',
  description:
    'Resolve one OR many Papercusp feature flags to booleans for this host — pass `key` for one or `keys` for several. Returns { ok, results:[{ ok, key, enabled | error }], counts } — correlate each result by its key, not by position.',
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'bee'],
  args: z
    .object({
      key: FlagKeySchema.optional().describe('a single flag key (n=1 shorthand for keys:[key])'),
      keys: z.array(FlagKeySchema).min(1).max(100).optional().describe('flag keys to resolve (1–100)'),
    })
    .refine((a) => Boolean(a.key) || (a.keys?.length ?? 0) > 0, {
      message: 'pass `key` (one) or `keys` (many)',
    }),
  async handler(args) {
    const fakeReq = new Request('http://localhost/agent-tool');
    const distinctId = resolveDistinctId(fakeReq);
    const keys = mergeIds(args.key, args.keys) as FlagKey[];
    const env = await runBulk(
      keys,
      async (key) => {
        const enabled = await getFlag(key, distinctId);
        return { ok: true as const, key, enabled };
      },
      { keyOf: (key) => ({ key }) },
    );
    return bulkContent(env);
  },
});
