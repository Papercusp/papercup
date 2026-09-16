import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { draftNewMail } from '../../capability-verbs/mail';
import { AddresseeRefused } from '../../capability-verbs/addressing';
import { addresseeArg, toProvenance } from '../_addressee-arg';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'mail:draft',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Draft a NEW email to recipients you name, outside any existing thread. It lands in the owner\'s own mailbox and is NOT sent — they read, edit and press send themselves. Addressees are checked exactly as mail:send checks them: one that appears only inside message content is REFUSED. Returns the draftId and who was addressed.',
  guidance: {
    when: 'Outbound the owner wants to read before it goes — a first approach, a batch they asked to look over, anything where their judgement should sit between you and the recipient. Review then happens in their own mail client, editable in place.',
    notWhen:
      'They asked you to actually send it — that is mail:send. Answering an existing email is mail:reply { mode:"draft" }, which needs no addressee because the server resolves it from the stored message.',
    chaining:
      'personal:search (contacts) → contactExternalId → mail:draft. Echo the returned recipients[] and draftId so a wrong addressee is visible while it is still only a draft.',
  },
  args: z
    .object({
      to: z.array(z.string().trim().min(3).max(320)).min(1).max(25),
      cc: z.array(z.string().trim().min(3).max(320)).max(25).optional(),
      subject: z.string().trim().min(1).max(998),
      text: z.string().trim().min(1).max(100_000),
      addressee: addresseeArg,
      from: z
        .string()
        .trim()
        .min(3)
        .max(320)
        .optional()
        .describe(
          'Which connected account to draft in, by its address. REQUIRED once the owner has connected more than one — a create-shaped draft has no thread to inherit the account from, so with several connected the call is refused rather than guessed, and the refusal names what is connected.',
        ),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('mail_draft_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:gmail']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await draftNewMail(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        to: args.to,
        cc: args.cc,
        subject: args.subject,
        text: args.text,
        provenance: toProvenance(args.addressee),
        from: args.from,
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof AddresseeRefused) {
        return {
          data: { ok: false, refused: true, code: error.code, address: error.address, standing: error.standing, detail: error.message },
        };
      }
      throw error;
    }
  },
});
