/**
 * Server-side helpers for the operator conversation log.
 *
 * One logical thread per (workspace_id, harness_slug). Both the text
 * sidebar and the ElevenLabs voice session append turns into the same
 * thread; the `source` column distinguishes them. See SPEC.md and the
 * B+C-lite architecture sketch (operator chat unification, 2026-05-10).
 */

import { getOrgPg } from '@restart/db-org';
import { ensureOperatorConversationsTable } from './ensure-schema';
import { activeWorkspaceId } from './workspace-registry';

export type TurnRole = 'user' | 'assistant' | 'system';
export type TurnSource = 'text_typed' | 'voice_stt' | 'voice_tts' | 'system';

export interface ConversationRow {
  id: string;
  workspaceId: string;
  harnessSlug: string | null;
  title: string | null;
  status: 'active' | 'done' | 'abandoned';
  startedAt: number;
  endedAt: number | null;
  elConversationIds: string[];
  hasAudio: boolean;
}

export interface TurnRow {
  id: string;
  conversationId: string;
  seq: number;
  role: TurnRole;
  text: string;
  source: TurnSource;
  elConvId: string | null;
  audioUrl: string | null;
  createdAt: number;
}

export async function getOrCreateActiveConversation(
  harnessSlug: string | null,
): Promise<ConversationRow> {
  await ensureOperatorConversationsTable();
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const slugKey = harnessSlug ?? '';

  const existing = (await sql`
    SELECT id, workspace_id, harness_slug, title, status, started_at, ended_at, el_conversation_ids, has_audio
      FROM harness_shared.operator_conversations
     WHERE workspace_id = ${ws}
       AND COALESCE(harness_slug, '') = ${slugKey}
       AND status = 'active'
     ORDER BY started_at DESC
     LIMIT 1
  `) as Array<Record<string, unknown>>;

  if (existing.length > 0) return rowToConversation(existing[0]);

  const created = (await sql`
    INSERT INTO harness_shared.operator_conversations
      (workspace_id, harness_slug, started_at)
    VALUES (${ws}, ${harnessSlug}, ${Date.now()})
    RETURNING id, workspace_id, harness_slug, title, status, started_at, ended_at, el_conversation_ids, has_audio
  `) as Array<Record<string, unknown>>;

  return rowToConversation(created[0]);
}

export async function listTurns(conversationId: string): Promise<TurnRow[]> {
  await ensureOperatorConversationsTable();
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT id, conversation_id, seq, role, text, source, el_conv_id, audio_url, created_at
      FROM harness_shared.operator_turns
     WHERE conversation_id = ${conversationId}
     ORDER BY seq ASC
  `) as Array<Record<string, unknown>>;
  return rows.map(rowToTurn);
}

export async function appendTurn(input: {
  conversationId: string;
  role: TurnRole;
  text: string;
  source?: TurnSource;
  elConvId?: string | null;
  audioUrl?: string | null;
}): Promise<TurnRow> {
  await ensureOperatorConversationsTable();
  const { sql } = getOrgPg();

  // Compute next seq. We collide-tolerate via the UNIQUE (conv,seq) constraint
  // and a single retry — concurrent inserters in the same conversation are
  // rare (one user, two transports max), so this is cheap.
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = (await sql`
      SELECT COALESCE(MAX(seq), -1) + 1 AS s
        FROM harness_shared.operator_turns
       WHERE conversation_id = ${input.conversationId}
    `) as Array<{ s: number }>;
    const seq = Number(next[0].s);
    try {
      const inserted = (await sql`
        INSERT INTO harness_shared.operator_turns
          (conversation_id, seq, role, text, source, el_conv_id, audio_url, created_at)
        VALUES
          (${input.conversationId}, ${seq}, ${input.role}, ${input.text},
           ${input.source ?? 'text_typed'}, ${input.elConvId ?? null},
           ${input.audioUrl ?? null}, ${Date.now()})
        RETURNING id, conversation_id, seq, role, text, source, el_conv_id, audio_url, created_at
      `) as Array<Record<string, unknown>>;
      return rowToTurn(inserted[0]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err; // not a unique violation
      // someone else took our seq — retry
    }
  }
  throw new Error('appendTurn: failed after 3 retries');
}

/** Replace the last assistant turn in place — used for EL barge-in correction. */
export async function correctLastAssistantTurn(
  conversationId: string,
  newText: string,
): Promise<TurnRow | null> {
  await ensureOperatorConversationsTable();
  const { sql } = getOrgPg();
  const rows = (await sql`
    UPDATE harness_shared.operator_turns
       SET text = ${newText}
     WHERE id = (
       SELECT id FROM harness_shared.operator_turns
        WHERE conversation_id = ${conversationId}
          AND role = 'assistant'
        ORDER BY seq DESC
        LIMIT 1
     )
    RETURNING id, conversation_id, seq, role, text, source, el_conv_id, audio_url, created_at
  `) as Array<Record<string, unknown>>;
  return rows.length > 0 ? rowToTurn(rows[0]) : null;
}

function rowToConversation(r: Record<string, unknown>): ConversationRow {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id ?? ''),
    harnessSlug: r.harness_slug == null ? null : String(r.harness_slug),
    title: r.title == null ? null : String(r.title),
    status: (r.status as ConversationRow['status']) ?? 'active',
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    elConversationIds: Array.isArray(r.el_conversation_ids)
      ? (r.el_conversation_ids as string[])
      : [],
    hasAudio: r.has_audio === true,
  };
}

function rowToTurn(r: Record<string, unknown>): TurnRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    seq: Number(r.seq),
    role: r.role as TurnRole,
    text: String(r.text),
    source: (r.source as TurnSource) ?? 'text_typed',
    elConvId: r.el_conv_id == null ? null : String(r.el_conv_id),
    audioUrl: r.audio_url == null ? null : String(r.audio_url),
    createdAt: Number(r.created_at),
  };
}
