/**
 * Agent-chats read/write API (non-streaming subset). Function-of-truth
 * for both the hono routes at /api/harness/:slug/agent-chats* and the
 * agent_chats:* MCP tools.
 *
 * The streaming POST (append message + SSE reply) stays in the hono
 * route file — bidirectional streams aren't projection-shaped.
 */

import { randomUUID } from 'node:crypto';
import { getLegacyClient } from '@papercusp/db-org';
import { getKnownRoles } from './known-roles';

export interface TranscriptToolCall {
  name: string;
  input?: unknown;
  /**
   * For interactive tools (chat:ask_choice etc.), the user's
   * response. Unified picks[] shape — length 1 for single-select,
   * ≥1 for multi-select. Mirrors operator_turns.tools so the same
   * React components render both surfaces.
   */
  answered?: {
    picks: Array<{ option_id: string; label: string }>;
    at: number;
  };
}

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_cents?: number;
  /**
   * Tool calls that fired during this turn (e.g. chat:ask_choice).
   * Persisted inside the parent agent_chats.transcript jsonb column —
   * no schema migration needed since transcript was already jsonb.
   */
  tools?: TranscriptToolCall[];
}

export interface ChatRow {
  id: string;
  role: string;
  feature_id: string | null;
  title: string | null;
  transcript: TranscriptTurn[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface FeatureLockState {
  taken_by: string | null;
  taken_at: string | null;
  expires_at: string | null;
  active: boolean;
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

const FEATURE_ID_RE = /^[A-Z][A-Z0-9_-]*[A-Z0-9]$/i;

function dbForSlug(slug: string) {
  return getLegacyClient(slug);
}

export function isValidChatRole(role: string): boolean {
  if (role === 'feedback') return false;
  return getKnownRoles().includes(role);
}

export function rowToChat(r: Record<string, unknown>): ChatRow {
  return {
    id: r.id as string,
    role: r.role as string,
    feature_id: (r.feature_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    transcript:
      typeof r.transcript === 'string'
        ? JSON.parse(r.transcript)
        : ((r.transcript as TranscriptTurn[] | undefined) ?? []),
    total_input_tokens:
      typeof r.total_input_tokens === 'bigint'
        ? Number(r.total_input_tokens)
        : ((r.total_input_tokens as number | undefined) ?? 0),
    total_output_tokens:
      typeof r.total_output_tokens === 'bigint'
        ? Number(r.total_output_tokens)
        : ((r.total_output_tokens as number | undefined) ?? 0),
    total_cost_usd_cents:
      typeof r.total_cost_usd_cents === 'bigint'
        ? Number(r.total_cost_usd_cents)
        : ((r.total_cost_usd_cents as number | undefined) ?? 0),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    archived_at: (r.archived_at as string | null) ?? null,
  };
}

export async function readFeatureLockState(
  slug: string,
  featureId: string,
): Promise<FeatureLockState | null> {
  try {
    const db = dbForSlug(slug);
    const row = (await db
      .prepare(
        'SELECT taken_by, taken_at, expires_at FROM harness_features WHERE harness_slug = ? AND feature_id = ? LIMIT 1',
      )
      .get(slug, featureId)) as
      | { taken_by: string | null; taken_at: string | null; expires_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      taken_by: row.taken_by,
      taken_at: row.taken_at,
      expires_at: row.expires_at,
      active: row.taken_by !== null,
    };
  } catch {
    return null;
  }
}

// ── reads ──────────────────────────────────────────────────────────

export interface ListChatsInput {
  slug: string;
  includeArchived?: boolean;
}

export async function listChats(input: ListChatsInput): Promise<Result<{ chats: ChatRow[] }>> {
  try {
    const db = dbForSlug(input.slug);
    const sql = input.includeArchived
      ? 'SELECT * FROM agent_chats ORDER BY updated_at DESC'
      : 'SELECT * FROM agent_chats WHERE archived_at IS NULL ORDER BY updated_at DESC';
    const rows = (await db.prepare(sql).all()) as Array<Record<string, unknown>>;
    return { ok: true, data: { chats: rows.map(rowToChat) } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to list chats: ${(e as Error).message}` };
  }
}

export interface GetChatInput {
  slug: string;
  chatId: string;
}

export async function getChat(
  input: GetChatInput,
): Promise<Result<ChatRow & { feature_lock: FeatureLockState | null }>> {
  try {
    const db = dbForSlug(input.slug);
    const row = (await db
      .prepare('SELECT * FROM agent_chats WHERE id = ?')
      .get(input.chatId)) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, status: 404, error: 'chat not found' };
    const chat = rowToChat(row);
    const featureLock = chat.feature_id
      ? await readFeatureLockState(input.slug, chat.feature_id)
      : null;
    return { ok: true, data: { ...chat, feature_lock: featureLock } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to load chat: ${(e as Error).message}` };
  }
}

// ── writes ─────────────────────────────────────────────────────────

export interface CreateChatInput {
  slug: string;
  role: string;
  feature_id?: string;
  title?: string;
}

export async function createChat(
  input: CreateChatInput,
): Promise<Result<ChatRow & { feature_lock: FeatureLockState | null }>> {
  if (!input.role || !isValidChatRole(input.role)) {
    return {
      ok: false,
      status: 400,
      error: `role must be one of: ${getKnownRoles()
        .filter((r) => r !== 'feedback')
        .join(', ')}`,
    };
  }
  if (input.feature_id && !FEATURE_ID_RE.test(input.feature_id)) {
    return { ok: false, status: 400, error: `invalid feature_id: ${input.feature_id}` };
  }

  const id = randomUUID();
  const title =
    input.title ?? (input.feature_id ? `${input.role} · ${input.feature_id}` : input.role);

  try {
    const db = dbForSlug(input.slug);
    await db
      .prepare(
        `INSERT INTO agent_chats (id, role, feature_id, title, transcript)
         VALUES (?, ?, ?, ?, ?::jsonb)`,
      )
      .run(id, input.role, input.feature_id ?? null, title, '[]');
    const row = (await db.prepare('SELECT * FROM agent_chats WHERE id = ?').get(id)) as Record<
      string,
      unknown
    >;
    const featureLock = input.feature_id
      ? await readFeatureLockState(input.slug, input.feature_id)
      : null;

    return { ok: true, data: { ...rowToChat(row), feature_lock: featureLock } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to create chat: ${(e as Error).message}` };
  }
}

export interface ArchiveChatInput {
  slug: string;
  chatId: string;
}

export async function archiveChat(input: ArchiveChatInput): Promise<Result<{ ok: true }>> {
  try {
    const db = dbForSlug(input.slug);
    const pre = (await db
      .prepare('SELECT role, feature_id FROM agent_chats WHERE id = ?')
      .get(input.chatId)) as
      | { role: string; feature_id: string | null }
      | undefined;
    await db
      .prepare('UPDATE agent_chats SET archived_at = now(), updated_at = now() WHERE id = ?')
      .run(input.chatId);
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to archive chat: ${(e as Error).message}` };
  }
}
