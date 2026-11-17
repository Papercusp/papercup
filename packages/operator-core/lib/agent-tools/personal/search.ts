import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { discloseDocuments } from '../../personal-vault/disclosure-ledger';
import { buildPersonalQueryEmbedder, PERSONAL_EMBEDDER_MODE } from '../../personal-vault/embedding';
import { searchPersonalDocuments } from '../../personal-vault/store';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import { resolveCanonicalDocument } from '../../capability-verbs/resolve';
import { invokeOutboundProvider, resolveCapabilitySource } from '../../capability-verbs/provider-dispatch';
import type postgres from 'postgres';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle'] as const;

export default defineTool({
  name: 'personal:search',
  needsWorkspaceTx: true,
  capability: 'search:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  description:
    'Search the owner-local Personal Vault, or read an imported mail message and its attachments live with read:{sourceId,messageId,attachmentId?}. Query describes the search or read purpose. DEFAULT DENY: a live owner grant is required; coding roles are refused even if a grant row exists.',
  guidance: {
    when: 'A granted plan or binding needs the owner\'s imported Gmail, Calendar, Contacts, Facebook/Instagram, or X context. Pass scopes and participant/time filters as narrowly as possible.',
    notWhen: 'General workspace memory/search — use memory:search or search:semantic. Never use from coding/review work; those roles are hard-denied.',
    chaining: 'Search returns ranked imported documents. To inspect an original email, pass its sourceId/externalId as read.sourceId/messageId. A live read returns the complete normalized message in results[].metadata; attachmentId retrieves one of its listed attachments as attachment.contentBase64. Large results use the normal recoverable result spill.',
  },
  args: z.object({
    query: z.string().min(1).max(500),
    read: z.object({
      sourceId: z.string().uuid(),
      messageId: z.string().trim().min(1).max(512),
      attachmentId: z.string().trim().min(1).max(4096).optional(),
    }).strict().optional(),
    scopes: z.array(z.string().min(1).max(80)).max(20).optional(),
    sourceIds: z.array(z.string().uuid()).max(20).optional(),
    providerAccountIds: z.array(z.string().min(1).max(512)).max(20).optional(),
    participants: z.array(z.string().min(1).max(320)).max(50).optional(),
    timeRange: z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      })
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('personal_search_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, args.read ? ['personal:mail'] : args.scopes ?? []);
    if (!auth.allowed) {
      return { data: { allowed: false, refusal: auth.reason, results: [], grantedScopes: auth.scopes } };
    }
    if (args.read) {
      const { sourceId, messageId, attachmentId } = args.read;
      const doc = await resolveCanonicalDocument(ctx.tx!, {
        workspaceId, userId: user.id, source: 'mail', sourceId, externalId: messageId,
      });
      if (doc.sourceId !== sourceId) throw new Error('personal_mail_source_mismatch');
      const sql = ctx.tx as unknown as postgres.Sql;
      const target = await resolveCapabilitySource(sql, {
        workspaceId, userId: user.id, datatype: 'email-message', sourceId,
        capabilities: attachmentId ? ['mail.read', 'mail.attachments'] : ['mail.read'],
      });
      const read = await invokeOutboundProvider(sql, target, 'mail.read', { messageId });
      const message = read.message;
      if (!message || typeof message !== 'object' || Array.isArray(message) ||
          (message as Record<string, unknown>).id !== messageId) {
        throw new Error('personal_mail_message_mismatch');
      }
      const metadata = { ...doc.payload, ...message as Record<string, unknown> };
      const disclosed = await discloseDocuments(ctx.tx!, {
        workspaceId, userId: user.id, agentOwnerId: disclosureSubject(ctx), via: 'personal:search',
        documents: [{ ...doc, metadata }],
      });
      // Withheld originals must not leak through either the message or binary result.
      if (disclosed.withheld) {
        return { data: { allowed: true, results: [], withheldRestricted: disclosed.withheld,
          withheldReason: 'disclosure_identity_unresolved', grantedScopes: auth.scopes } };
      }
      let attachment: Record<string, unknown> | undefined;
      if (attachmentId) {
        // Gmail can mint a different opaque attachment token on every message
        // read. Comparing against this fresh list rejects a reference from the
        // caller's previous read. The provider resolves the original token at
        // its exact source/message resource (Gmail: messages/{id}/attachments/{id}).
        attachment = await invokeOutboundProvider(sql, target, 'mail.attachments', { messageId, attachmentId });
        if (attachment.messageId !== messageId || attachment.attachmentId !== attachmentId) {
          throw new Error('personal_mail_attachment_mismatch');
        }
      }
      return { data: { allowed: true, principal: auth.principal, grantedScopes: auth.scopes,
        live: true, results: disclosed.documents, ...(attachment ? { attachment } : {}),
        ...(disclosed.disclosed ? { restrictedResults: disclosed.disclosed,
          restrictionNote: 'The original message and attachment carry the returned privacy label and constrain subsequent sends.' } : {}),
      } };
    }
    let queryEmbedding: number[] | null = null;
    let vectorLeg: 'gemma' | 'unavailable' = 'unavailable';
    try {
      const embed = await buildPersonalQueryEmbedder();
      queryEmbedding = await embed(args.query);
      vectorLeg = PERSONAL_EMBEDDER_MODE;
    } catch {
      // Lexical search remains useful and grant enforcement is unchanged.
    }
    const found = await searchPersonalDocuments(ctx.tx!, workspaceId, user.id, {
      ...args,
      scopes: auth.scopes,
      queryEmbedding,
    });
    // Same transaction as the read: a restricted result reaches the agent only
    // with its disclosure row, and then constrains every send it makes.
    const disclosed = await discloseDocuments(ctx.tx!, {
      workspaceId,
      userId: user.id,
      agentOwnerId: disclosureSubject(ctx),
      documents: found,
      via: 'personal:search',
    });
    return {
      data: {
        allowed: true,
        principal: auth.principal,
        grantedScopes: auth.scopes,
        vectorLeg,
        results: disclosed.documents,
        ...(disclosed.disclosed
          ? { restrictedResults: disclosed.disclosed, restrictionNote: 'Results carrying `privacy` are restricted: until the owner releases them, you may send only to their privacy.readerSet (intersected across everything restricted you have read) or to the owner.' }
          : {}),
        ...(disclosed.withheld ? { withheldRestricted: disclosed.withheld, withheldReason: 'disclosure_identity_unresolved' } : {}),
      },
    };
  },
});
