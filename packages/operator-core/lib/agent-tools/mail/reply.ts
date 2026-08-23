import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { replyToCanonicalMail } from '../../capability-verbs/mail';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'mail:reply',
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Reply to one email the owner already has, named by its canonical messageId. You supply TEXT ONLY: the server resolves recipient, thread, subject and reply headers from the stored message, so this tool cannot redirect a reply or read the credential. Drafts by default; mode:"send" sends.',
  guidance: {
    when: 'The owner asks you to answer a specific email. Locate it with personal:search { scopes:["personal:gmail"] } and pass the externalId it returns as messageId.',
    notWhen:
      'Writing to a NEW recipient or starting a fresh thread — that is mail:send, which checks the addressee. Not for Slack (chat:reply). You cannot choose who this reaches.',
    chaining:
      'personal:search → externalId → mail:reply. Report the echoed to/subject/threadId back to the owner as evidence of where it actually went.',
  },
  args: z
    .object({
      messageId: z.string().trim().min(1).max(512),
      text: z.string().trim().min(1).max(100_000),
      mode: z.enum(['draft', 'send']).optional(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('mail_reply_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:gmail']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    const result = await replyToCanonicalMail(ctx.tx as unknown as postgres.Sql, {
      workspaceId,
      userId: user.id,
      messageId: args.messageId,
      text: args.text,
      mode: args.mode ?? 'draft',
    });
    return { data: { ok: true, ...result } };
  },
});
