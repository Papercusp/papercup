import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { purgePersonalSource } from '../../personal-vault/store';
import type { PapercuspToolContext } from '../_tool-context';

export default defineTool({
  name: 'personal:purge',
  needsWorkspaceTx: true,
  capability: 'memory:write',
  description:
    'OWNER-only verified deletion of Personal Vault data. Deletes a source (documents including vectors, sync cursor, source aliases) or the whole vault corpus; retained grant history is untouched. Requires confirm:true.',
  guidance: {
    when: 'The owner asks to remove one imported source or erase all Personal Vault content.',
    notWhen: 'Revoking agent access without deleting data — use the Personal Vault settings UI grant controls.',
  },
  args: z.object({
    source: z.string().min(1).max(64).optional(),
    confirm: z.literal(true),
  }),
  async handler(args, ctx: PapercuspToolContext) {
    if (ctx.principal.kind !== 'user') throw new Error('personal_purge_owner_principal_required');
    const workspaceId = ctx.principal.workspaceId;
    const user = await getSessionUserOrDefault();
    return {
      data: {
        ok: true,
        source: args.source ?? 'all',
        deleted: await purgePersonalSource(ctx.tx!, workspaceId, user.id, args.source),
      },
    };
  },
});
