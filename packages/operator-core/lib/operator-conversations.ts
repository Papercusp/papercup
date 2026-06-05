/**
 * Server-side helpers for the operator conversation log.
 *
 * **Workspace-scoped**: one logical thread per workspace_id. The
 * `operator_conversations` table still has a `harness_slug` column for
 * back-compat with the original (workspace_id, harness_slug)-keyed
 * design, but new code MUST NOT vary by harness — switching harnesses
 * should never spawn or surface a different conversation. Both the
 * text sidebar and the ElevenLabs voice session append turns into the
 * same thread; the `source` column distinguishes them.
 *
 * See SPEC.md and the B+C-lite architecture sketch (operator chat
 * unification, 2026-05-10).
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { and, desc, eq, lt as dlt, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from './workspace-registry';

const oc = generated.operatorConversationsInHarnessShared;
const ot = generated.operatorTurnsInHarnessShared;

const conversationCols = {
  id: oc.id,
  workspace_id: oc.workspaceId,
  harness_slug: oc.harnessSlug,
  title: oc.title,
  status: oc.status,
  started_at: oc.startedAt,
  ended_at: oc.endedAt,
  el_conversation_ids: oc.elConversationIds,
  has_audio: oc.hasAudio,
} as const;

const turnCols = {
  id: ot.id,
  conversation_id: ot.conversationId,
  seq: ot.seq,
  role: ot.role,
  text: ot.text,
  source: ot.source,
  el_conv_id: ot.elConvId,
  audio_url: ot.audioUrl,
  created_at: ot.createdAt,
  tools: ot.tools,
} as const;

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

/**
 * A tool-call entry stored alongside a turn's text. Used for
 * chat:ask_choice (and future generative-UI tools) so the card +
 * its answered state survives page reload. Persisted to
 * operator_turns.tools jsonb (migration 015).
 */
export interface TurnToolCall {
  name: string;
  input?: unknown;
  /**
   * Picks array — length 1 for single-select cards, ≥1 for multi.
   * Unified shape across single + multi (pre-alpha policy, no
   * legacy single-select variant carried).
   */
  answered?: {
    picks: Array<{ option_id: string; label: string }>;
    at: number;
  };
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
  tools: TurnToolCall[] | null;
}

/**
 * Returns the workspace's active operator conversation, creating it if
 * none exists. Workspace-scoped: NEVER varies by harness slug. The
 * `harness_slug` column is always written as NULL on new rows.
 */
export async function getOrCreateActiveConversation(): Promise<ConversationRow> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();

  const existing = await db
    .select(conversationCols)
    .from(oc)
    .where(and(eq(oc.workspaceId, ws), eq(oc.status, 'active')))
    .orderBy(desc(oc.startedAt))
    .limit(1);

  if (existing.length > 0) return rowToConversation(existing[0] as Record<string, unknown>);

  const created = await db
    .insert(oc)
    .values({ workspaceId: ws, harnessSlug: null, startedAt: Date.now() })
    .returning(conversationCols);

  return rowToConversation(created[0] as Record<string, unknown>);
}

export async function listTurns(conversationId: string): Promise<TurnRow[]> {
  const { db } = getOrgPg();
  const rows = await db
    .select(turnCols)
    .from(ot)
    .where(eq(ot.conversationId, conversationId))
    .orderBy(ot.seq);
  return (rows as Array<Record<string, unknown>>).map(rowToTurn);
}

export interface TurnsPage {
  /** Turns in this page, in seq ASC order (oldest first within the page). */
  turns: TurnRow[];
  /** True when at least one turn exists earlier than the lowest seq in `turns`. */
  hasMoreEarlier: boolean;
}

/**
 * Cursor-paginated read for chat infinite scroll. Returns the newest
 * `limit` turns whose `seq < beforeSeq` (or the newest `limit` overall
 * when `beforeSeq` is null).
 *
 * The list is returned in ASC order so the UI can simply prepend it.
 * `hasMoreEarlier` enables the chat client to suppress its load-earlier
 * sentinel once the tail is reached.
 */
export async function listTurnsRecent(args: {
  conversationId: string;
  beforeSeq?: number | null;
  limit?: number;
}): Promise<TurnsPage> {
  const { db } = getOrgPg();
  const limit = Math.max(1, Math.min(args.limit ?? 50, 500));
  const beforeSeq = args.beforeSeq ?? null;

  // Fetch newest N below the cursor, then sort ASC for the UI.
  const where = beforeSeq === null
    ? eq(ot.conversationId, args.conversationId)
    : and(eq(ot.conversationId, args.conversationId), dlt(ot.seq, beforeSeq));
  const rows = await db
    .select(turnCols)
    .from(ot)
    .where(where)
    .orderBy(desc(ot.seq))
    .limit(limit);
  const turns = (rows as Array<Record<string, unknown>>).map(rowToTurn).reverse();

  // hasMoreEarlier: is there at least one row with seq < min(turns.seq)?
  let hasMoreEarlier = false;
  if (turns.length > 0) {
    const minSeq = turns[0].seq;
    const probe = await db
      .select({ id: ot.id })
      .from(ot)
      .where(and(eq(ot.conversationId, args.conversationId), dlt(ot.seq, minSeq)))
      .limit(1);
    hasMoreEarlier = probe.length > 0;
  }
  return { turns, hasMoreEarlier };
}

export async function appendTurn(input: {
  conversationId: string;
  role: TurnRole;
  text: string;
  source?: TurnSource;
  elConvId?: string | null;
  audioUrl?: string | null;
  /**
   * Tool calls that fired during this turn (e.g. chat:ask_choice).
   * Persisted to operator_turns.tools jsonb. Pass null/omit when the
   * turn had no tool calls.
   */
  tools?: TurnToolCall[] | null;
}): Promise<TurnRow> {
  const { db } = getOrgPg();

  // Compute next seq. We collide-tolerate via the UNIQUE (conv,seq) constraint
  // and a single retry — concurrent inserters in the same conversation are
  // rare (one user, two transports max), so this is cheap.
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await db
      .select({ s: dsql<number>`COALESCE(MAX(${ot.seq}), -1) + 1` })
      .from(ot)
      .where(eq(ot.conversationId, input.conversationId));
    const seq = Number(next[0].s);
    try {
      // Drizzle has a known jsonb auto-conversion bug
      // (commit 98cfffb7 — three ui:* routes reverted from drizzle to
      // raw sql for the same reason). The established workaround is
      // to write jsonb via raw `${JSON.stringify(x)}::jsonb` instead
      // of letting drizzle's encoder touch the value. Pre-stringify
      // here and pass as the raw cast for the tools column only.
      const toolsJson = input.tools && input.tools.length > 0
        ? JSON.stringify(input.tools)
        : null;
      const { sql: rawSql } = getOrgPg();
      const inserted = (await rawSql.unsafe(
        `INSERT INTO harness_shared.operator_turns
           (conversation_id, seq, role, text, source, el_conv_id,
            audio_url, created_at, tools)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING id, conversation_id, seq, role, text, source,
                   el_conv_id, audio_url, created_at, tools`,
        [
          input.conversationId,
          seq,
          input.role,
          input.text,
          input.source ?? 'text_typed',
          input.elConvId ?? null,
          input.audioUrl ?? null,
          Date.now(),
          toolsJson,
        ],
      )) as Array<Record<string, unknown>>;
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
  const { db } = getOrgPg();
  // UPDATE ... WHERE id = (SELECT id ... ORDER BY ... LIMIT 1) — drizzle
  // doesn't have a direct subquery-in-WHERE primitive that's cleaner than
  // composing it via dsql. Build the subquery as a Drizzle qb then pass it.
  const subq = db
    .select({ id: ot.id })
    .from(ot)
    .where(and(eq(ot.conversationId, conversationId), eq(ot.role, 'assistant')))
    .orderBy(desc(ot.seq))
    .limit(1);
  const rows = await db
    .update(ot)
    .set({ text: newText })
    .where(dsql`${ot.id} = (${subq})`)
    .returning(turnCols);
  return rows.length > 0 ? rowToTurn(rows[0] as Record<string, unknown>) : null;
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
    tools: Array.isArray(r.tools) ? (r.tools as TurnToolCall[]) : null,
  };
}
