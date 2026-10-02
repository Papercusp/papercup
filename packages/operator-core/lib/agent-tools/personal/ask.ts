import type postgres from 'postgres';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import {
  DELEGATE_SYSTEM_PROMPT,
  delegatedRead,
  type DelegateAnswerer,
} from '../../personal-vault/delegated-read';
import { buildPersonalQueryEmbedder } from '../../personal-vault/embedding';
import { searchPersonalDocuments } from '../../personal-vault/store';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle'] as const;

/** The production delegate: one tool-less model call, so it can send nothing. */
const modelDelegate: DelegateAnswerer = async ({ question, documents }) => {
  const { llmCall } = await import('../../llm-testing/llm-client');
  const res = await llmCall({
    model: 'sonnet',
    system: DELEGATE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Question: ${question}\n\nDocuments:\n${documents}` }],
    maxTokens: 400,
    temperature: 0,
  });
  return res.text;
};

export default defineTool({
  name: 'personal:ask',
  capability: 'search:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  description:
    'Ask a question of the owner-local Personal Vault through a hidden delegate that reads the matching documents and answers. The answer reaches you without a privacy label only when it carries no restricted text or names; otherwise it is withheld unless you pass acceptLabel. DEFAULT DENY, as personal:search.',
  guidance: {
    when: 'You need a fact FROM personal data (a count, a yes/no, a date) and do not need the documents themselves — the answer leaves your sending unrestricted when it carries no restricted content.',
    notWhen: 'You need the documents or their wording — use personal:search, which labels you for every restricted result it returns.',
    chaining: 'withheld:true means the answer would carry restricted content. Re-ask more narrowly, or pass acceptLabel:true to receive it and be limited to those documents\' readers (privacy.readerSet) until the owner releases them.',
  },
  args: z.object({
    question: z.string().min(1).max(500),
    scopes: z.array(z.string().min(1).max(80)).max(20).optional(),
    sourceIds: z.array(z.string().uuid()).max(20).optional(),
    participants: z.array(z.string().min(1).max(320)).max(50).optional(),
    timeRange: z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      })
      .optional(),
    limit: z.number().int().min(1).max(20).optional(),
    acceptLabel: z.boolean().optional(),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('personal_ask_workspace_required');
    const user = await getSessionUserOrDefault();
    const { sql } = getOrgPg();
    // No transaction is held across the delegate's model call (it can outlast
    // idle_in_transaction_session_timeout): search in one, deliver in another.
    const inWorkspaceTx = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      sql.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
        return fn(tx);
      }) as Promise<T>;

    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await (await buildPersonalQueryEmbedder())(args.question);
    } catch {
      // Lexical search remains useful and grant enforcement is unchanged.
    }
    const gathered = await inWorkspaceTx(async (tx) => {
      const auth = await authorizePersonalAccess(tx, ctx, workspaceId, user.id, args.scopes ?? []);
      if (!auth.allowed) return { auth, found: [] };
      const found = await searchPersonalDocuments(tx, workspaceId, user.id, {
        query: args.question,
        scopes: auth.scopes,
        sourceIds: args.sourceIds,
        participants: args.participants,
        timeRange: args.timeRange,
        limit: args.limit ?? 10,
        queryEmbedding,
      });
      return { auth, found };
    });
    if (!gathered.auth.allowed) {
      return { data: { allowed: false, refusal: gathered.auth.reason, grantedScopes: gathered.auth.scopes } };
    }

    const result = await delegatedRead(
      {
        workspaceId,
        userId: user.id,
        callerOwnerId: disclosureSubject(ctx),
        question: args.question,
        documents: gathered.found,
        acceptLabel: args.acceptLabel === true,
      },
      { answer: modelDelegate, inWorkspaceTx },
    );
    if (!result.delivered) {
      return {
        data: {
          allowed: true,
          withheld: true,
          reason: result.reason,
          consulted: result.consulted,
          carriedRestricted: result.carriedRestricted,
          hint:
            result.reason === 'disclosure_identity_unresolved'
              ? 'This call has no attributable agent identity, so it cannot carry a privacy label; restricted content cannot be delivered to it.'
              : 'The answer would carry restricted text or names. Ask more narrowly, or pass acceptLabel:true to receive it and be limited to those documents\' readers.',
        },
      };
    }
    return {
      data: {
        allowed: true,
        withheld: false,
        answer: result.answer,
        consulted: result.consulted,
        labelled: result.labelled,
        ...(result.labelled
          ? {
              labels: result.labels,
              restrictionNote: 'This answer carries restricted content: until the owner releases it, you may send only to its privacy.readerSet (intersected across everything restricted you have read) or to the owner.',
            }
          : {}),
      },
    };
  },
});
