/**
 * POST /api/operator/conversations/:id/turn-answer
 *
 * Historical-replay surface only. NEW chat:ask_choice flow uses
 * /card-response (bespoke-card-improvements arc, PRs #80-#83): the
 * tool BLOCKS on ctx.askUser, the card lives on the state channel,
 * the user submits via PendingCardsBar → POST /card-response → the
 * deferred resolves → chat:ask_choice returns picks → operator:converse
 * continues. No /turn-answer call in that flow.
 *
 * This endpoint stays alive to serve HISTORICAL conversations: turn
 * records persisted before the migration carry unanswered chat:ask_choice
 * tool_calls. Opening one of those conversations renders the card via
 * the legacy chat-cards path, and clicking POSTs here. The "legacy
 * adapter" framing in the plan turned out to be a misnomer — there's
 * nothing to translate forward; the two endpoints serve different
 * surfaces (in-flight vs historical) and both stay.
 *
 * Atomic behavior on this surface:
 *   1. Marks an assistant turn's tool-call entry as `answered` (jsonb
 *      path update) — records option_id + label + timestamp.
 *   2. Appends a user turn with the option's label as the visible
 *      text (and source='card_pick' for audit clarity).
 *
 * Both writes happen in one PG transaction so the assistant's
 * answered-state and the user's reply land together; a partial failure
 * mid-flow can't leave the chat in a state where the model thinks the
 * user answered but the audit log disagrees.
 *
 * Idempotent: if the targeted tool entry already has `answered`, the
 * second call returns 409 with the current state (so the client knows
 * not to double-send the user message).
 *
 * Used by historical chat:ask_choice cards in the operator chat sidebar.
 * Oracle is in-memory only and doesn't hit this endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { ensureOperatorConversationsTable } from '@/lib/ensure-schema';
import { notifySyncInvalidate } from '@/lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  /** seq of the assistant turn that emitted the chat:ask_choice tool call. */
  assistantSeq: number;
  /** Index into that turn's `tools` array. */
  toolIndex: number;
  /**
   * Picks the user committed. Length 1 for single-select cards;
   * ≥1 for multi-select (args.multi=true). All ids must appear in
   * the tool's args.options. The new user turn's text is the joined
   * labels (" · ").
   */
  picks: Array<{ option_id: string; label: string }>;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: conversationId } = await ctx.params;
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
    return NextResponse.json(
      {
        error:
          'assistantSeq:number, toolIndex:number, picks:[{option_id, label}, ...] (1..6) required',
      },
      { status: 400 },
    );
  }

  await ensureOperatorConversationsTable();
  const { sql } = getOrgPg();
  const now = Date.now();
  const answeredJson = JSON.stringify({
    picks: body.picks,
    at: now,
  });
  // Joined labels for the new user turn's text. " · " separator
  // (middle dot) is visually compact and unambiguous; the operator
  // model parses the joined string by reading each comma-or-dot
  // chunk as a discrete user pick. For single-select, this is just
  // the single label (no separator).
  const joinedLabels = body.picks.map((p) => p.label).join(' · ');

  try {
    const result = await sql.begin(async (tx) => {
      // 1. Fetch the assistant row + sanity-check the tool entry shape.
      //    Locking it FOR UPDATE so a concurrent answer can't race.
      const rows = (await tx.unsafe(
        `SELECT id, tools FROM harness_shared.operator_turns
          WHERE conversation_id = $1 AND seq = $2 AND role = 'assistant'
          FOR UPDATE`,
        [conversationId, body.assistantSeq],
      )) as Array<{ id: string; tools: unknown }>;

      if (rows.length === 0) {
        return { kind: 'not_found' as const };
      }
      const tools = Array.isArray(rows[0].tools) ? (rows[0].tools as Array<Record<string, unknown>>) : [];
      const tool = tools[body.toolIndex];
      if (!tool || typeof tool !== 'object') {
        return { kind: 'bad_index' as const };
      }
      if (tool.name !== 'chat:ask_choice') {
        return { kind: 'wrong_tool' as const, name: tool.name };
      }
      if (tool.answered) {
        return { kind: 'already_answered' as const, answered: tool.answered };
      }
      // Sanity: verify every picked option_id exists in the args.
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

      // 2. Update the assistant row's tools[toolIndex].answered via jsonb_set.
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

      // 3. Compute next seq + insert user turn.
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

      return {
        kind: 'ok' as const,
        userSeq,
        userId: inserted[0].id,
      };
    });

    if (result.kind === 'not_found') {
      return NextResponse.json({ error: 'assistant turn not found' }, { status: 404 });
    }
    if (result.kind === 'bad_index') {
      return NextResponse.json({ error: 'toolIndex out of range' }, { status: 400 });
    }
    if (result.kind === 'wrong_tool') {
      return NextResponse.json(
        { error: `tool at index is "${result.name}", not chat:ask_choice` },
        { status: 400 },
      );
    }
    if (result.kind === 'already_answered') {
      return NextResponse.json(
        { error: 'already answered', answered: result.answered },
        { status: 409 },
      );
    }
    if (result.kind === 'unknown_option') {
      return NextResponse.json(
        {
          error: 'unknown option_id(s) — not present in args.options',
          unknownIds: result.unknownIds,
          validIds: result.validIds,
        },
        { status: 400 },
      );
    }

    // Push a sync invalidate so any other open tabs see the new state.
    void notifySyncInvalidate('operatorTurns.byConversation', { conversationId })
      .catch(() => { /* best-effort */ });

    return NextResponse.json({
      ok: true,
      userSeq: result.userSeq,
      userId: result.userId,
      answeredAt: now,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `turn-answer failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
