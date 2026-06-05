/**
 * POST /api/operator/conversations/:id/turn-answer
 *
 * Historical-replay surface for chat:ask_choice cards persisted before
 * the bespoke-card-improvements migration. Atomic answered-mark + user-turn
 * append in one PG transaction.
 *
 * Ported from app/api/operator/conversations/[id]/turn-answer/route.ts. `auth: 'public'`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  assistantSeq: number;
  toolIndex: number;
  picks: Array<{ option_id: string; label: string }>;
}

export default defineTool({
  method: 'POST',
  path: '/operator/conversations/:id/turn-answer',
  auth: 'public',
  async handler(req, ctx) {
    const conversationId = ctx.params.id as string;
    const body = (await req.json().catch(() => null)) as Body | null;
    if (
      !body ||
      typeof body.assistantSeq !== 'number' ||
      typeof body.toolIndex !== 'number' ||
      body.toolIndex < 0 ||
      !Array.isArray(body.picks) ||
      body.picks.length === 0 ||
      body.picks.length > 6 ||
      !body.picks.every(
        (p) =>
          p &&
          typeof p.option_id === 'string' &&
          p.option_id.length > 0 &&
          typeof p.label === 'string' &&
          p.label.length > 0,
      )
    ) {
      return Response.json(
        {
          error:
            'assistantSeq:number, toolIndex:number, picks:[{option_id, label}, ...] (1..6) required',
        },
        { status: 400 },
      );
    }

    const { sql } = getOrgPg();
    const now = Date.now();
    const answeredJson = JSON.stringify({ picks: body.picks, at: now });
    const joinedLabels = body.picks.map((p) => p.label).join(' · ');

    try {
      const result = await sql.begin(async (tx) => {
        const rows = (await tx.unsafe(
          `SELECT id, tools FROM harness_shared.operator_turns
            WHERE conversation_id = $1 AND seq = $2 AND role = 'assistant'
            FOR UPDATE`,
          [conversationId, body.assistantSeq],
        )) as Array<{ id: string; tools: unknown }>;

        if (rows.length === 0) return { kind: 'not_found' as const };
        const tools = Array.isArray(rows[0].tools)
          ? (rows[0].tools as Array<Record<string, unknown>>)
          : [];
        const tool = tools[body.toolIndex];
        if (!tool || typeof tool !== 'object') return { kind: 'bad_index' as const };
        if (tool.name !== 'chat:ask_choice') {
          return { kind: 'wrong_tool' as const, name: tool.name };
        }
        if (tool.answered) {
          return { kind: 'already_answered' as const, answered: tool.answered };
        }
        const args = (tool.input ?? tool.args) as { options?: Array<{ id?: string }> } | undefined;
        const knownIds = new Set(
          (args?.options ?? []).map((o) => o?.id).filter((s): s is string => !!s),
        );
        if (knownIds.size > 0) {
          const unknown = body.picks.filter((p) => !knownIds.has(p.option_id)).map((p) => p.option_id);
          if (unknown.length > 0) {
            return { kind: 'unknown_option' as const, validIds: [...knownIds], unknownIds: unknown };
          }
        }

        await tx.unsafe(
          `UPDATE harness_shared.operator_turns
              SET tools = jsonb_set(
                COALESCE(tools, '[]'::jsonb),
                ARRAY[$1::text, 'answered'],
                $2::jsonb,
                true
              )
            WHERE conversation_id = $3 AND seq = $4`,
          [String(body.toolIndex), answeredJson, conversationId, body.assistantSeq],
        );

        const nextSeq = (await tx.unsafe(
          `SELECT COALESCE(MAX(seq), -1) + 1 AS s
             FROM harness_shared.operator_turns
            WHERE conversation_id = $1`,
          [conversationId],
        )) as Array<{ s: number }>;
        const userSeq = Number(nextSeq[0].s);
        const inserted = (await tx.unsafe(
          `INSERT INTO harness_shared.operator_turns
             (conversation_id, seq, role, text, source, created_at)
           VALUES ($1, $2, 'user', $3, 'card_pick', $4)
           RETURNING id, seq`,
          [conversationId, userSeq, joinedLabels, now],
        )) as Array<{ id: string; seq: number }>;

        return { kind: 'ok' as const, userSeq, userId: inserted[0].id };
      });

      if (result.kind === 'not_found') {
        return Response.json({ error: 'assistant turn not found' }, { status: 404 });
      }
      if (result.kind === 'bad_index') {
        return Response.json({ error: 'toolIndex out of range' }, { status: 400 });
      }
      if (result.kind === 'wrong_tool') {
        return Response.json(
          { error: `tool at index is "${result.name}", not chat:ask_choice` },
          { status: 400 },
        );
      }
      if (result.kind === 'already_answered') {
        return Response.json(
          { error: 'already answered', answered: result.answered },
          { status: 409 },
        );
      }
      if (result.kind === 'unknown_option') {
        return Response.json(
          {
            error: 'unknown option_id(s) — not present in args.options',
            unknownIds: result.unknownIds,
            validIds: result.validIds,
          },
          { status: 400 },
        );
      }

      void notifySyncInvalidate('operatorTurns.byConversation', { conversationId })
        .catch(() => { /* best-effort */ });

      return Response.json({
        ok: true,
        userSeq: result.userSeq,
        userId: result.userId,
        answeredAt: now,
      });
    } catch (err) {
      return Response.json(
        { error: `turn-answer failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }
  },
});
