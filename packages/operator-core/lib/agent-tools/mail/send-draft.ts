import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { sendMailDraft } from '../../capability-verbs/mail';
import { AddresseeRefused } from '../../capability-verbs/addressing';
import { addresseeArg, toProvenance } from '../_addressee-arg';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'mail:send-draft',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Send an EXISTING draft by id, shipping the exact bytes already in the mailbox — nothing is re-composed. `expectedTo` is who you believe the draft is addressed to: the live draft is read back first, and the send is REFUSED if its recipients differ or if any of them fails the injected-addressee check. Returns the addresses it actually went to.',
  guidance: {
    when: 'Sending outbound a human has already reviewed in their own mail client. Pass the draftId you recorded when the draft was created, and expectedTo as the recipients that were approved.',
    notWhen:
      'Composing new outbound — that is mail:send. Do not use this to "send what I just drafted" without passing expectedTo: the check that the draft still addresses who you think is the entire reason this verb exists.',
    chaining:
      'mail:draft → draftId (record it) → owner reviews → mail:send-draft { draftId, expectedTo }. Echo sentTo[] to the owner: that is read back from the mailbox, so it is what actually shipped.',
  },
  args: z
    .object({
      draftId: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .describe('The Gmail draft id to send. Its bytes ship as-is; no subject/text is accepted here by design.'),
      expectedTo: z
        .array(z.string().trim().min(3).max(320))
        .min(1)
        .max(25)
        .describe(
          'Who you believe this draft is addressed to. NOT used to address the message — the draft carries its own recipients — but checked against them. A draft edited since you last saw it REFUSES instead of sending somewhere unapproved.',
        ),
      expectedCc: z.array(z.string().trim().min(3).max(320)).max(25).optional(),
      from: z
        .string()
        .trim()
        .min(3)
        .max(320)
        .optional()
        .describe('Which connected account holds the draft; required once more than one is connected.'),
      addressee: addresseeArg,
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('mail_send_draft_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:gmail']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await sendMailDraft(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        draftId: args.draftId,
        expectedTo: args.expectedTo,
        expectedCc: args.expectedCc,
        from: args.from,
        provenance: toProvenance(args.addressee),
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof AddresseeRefused) {
        return {
          data: { ok: false, refused: true, code: error.code, address: error.address, standing: error.standing, detail: error.message },
        };
      }
      // A recipient mismatch is a REFUSAL, not a crash: the caller's next move
      // is to re-read the draft and decide, which needs the message intact.
      if (error instanceof Error && error.message.startsWith('mail_send_draft_recipients_changed')) {
        return { data: { ok: false, refused: true, code: 'recipients_changed', detail: error.message } };
      }
      throw error;
    }
  },
});
