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
  /**
   * Marks an assistant turn that FAILED (rate-limit, backend error, dispatch
   * error) instead of producing a reply. `content` holds the failure message.
   * Persisted so a reload / second viewer sees the failure instead of a silent
   * gap (the live sender also gets the inline error banner). jsonb — no migration.
   */
  error?: boolean;
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

/**
 * A list-row projection of ChatRow that OMITS the heavy `transcript` jsonb
 * body — a forever-growing per-chat blob — and carries only its length as
 * `turn_count`. The list never needs the bodies: the MCP `agent_chats:list`
 * tool directs transcript reads to `agent_chats:get`, and the cross-harness
 * fan-out in agents-list only reads role + updated_at. Selecting `turn_count`
 * server-side instead of every full transcript is the F-C1 "select needed
 * columns" fix (it mirrors the admin comms rollup's
 * `jsonb_array_length(transcript) AS turns`), and it matters most under the
 * F-C2 fan-out where this list is hit once per harness.
 */
export interface ChatSummary {
  id: string;
  role: string;
  feature_id: string | null;
  title: string | null;
  turn_count: number;
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
  return getKnownRoles().includes(role);
}

/**
 * Coerce an epoch-millisecond timestamp (bigint | number | numeric-string, as
 * postgres-js may return int8) to an ISO string, preserving the ChatRow API
 * contract. agent_chats consolidated stores bigint epoch-ms (the consolidation
 * standard); the per-harness timestamptz columns were retired in migration 116.
 */
function msToIso(v: unknown): string {
  if (v == null) return '';
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  return new Date(n).toISOString();
}
function msToIsoNullable(v: unknown): string | null {
  if (v == null) return null;
  const iso = msToIso(v);
  return iso === '' ? null : iso;
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
    created_at: msToIso(r.created_at),
    updated_at: msToIso(r.updated_at),
    archived_at: msToIsoNullable(r.archived_at),
  };
}

/** Map a projected list row (no transcript body, a `turn_count` instead) to a
 *  ChatSummary. Reuses the same bigint/epoch-ms coercions as rowToChat. */
export function rowToChatSummary(r: Record<string, unknown>): ChatSummary {
  const toNum = (v: unknown): number =>
    typeof v === 'bigint' ? Number(v) : ((v as number | undefined) ?? 0);
  return {
    id: r.id as string,
    role: r.role as string,
    feature_id: (r.feature_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    turn_count: toNum(r.turn_count),
    total_input_tokens: toNum(r.total_input_tokens),
    total_output_tokens: toNum(r.total_output_tokens),
    total_cost_usd_cents: toNum(r.total_cost_usd_cents),
    created_at: msToIso(r.created_at),
    updated_at: msToIso(r.updated_at),
    archived_at: msToIsoNullable(r.archived_at),
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

/** Default page size for listChats — agent_chats is a forever-growing table,
 *  so the query is always bounded. Matches the 1..100 clamp on sibling list
 *  tools (agents:list). Callers page via `offset`. */
export const LIST_CHATS_DEFAULT_LIMIT = 100;
export const LIST_CHATS_MAX_LIMIT = 100;

/** Columns listChats projects — everything EXCEPT the heavy `transcript` jsonb
 *  body, which is replaced by its length (`turn_count`). See ChatSummary. */
const LIST_CHATS_COLUMNS =
  'id, role, feature_id, title, ' +
  'total_input_tokens, total_output_tokens, total_cost_usd_cents, ' +
  'created_at, updated_at, archived_at, ' +
  "jsonb_array_length(COALESCE(transcript, '[]'::jsonb)) AS turn_count";

export interface ListChatsInput {
  slug: string;
  includeArchived?: boolean;
  /** Page size, clamped to 1..LIST_CHATS_MAX_LIMIT. Defaults to LIST_CHATS_DEFAULT_LIMIT. */
  limit?: number;
  /** Keyset offset (rows to skip, ordered by updated_at DESC). Defaults to 0. */
  offset?: number;
}

export async function listChats(input: ListChatsInput): Promise<Result<{ chats: ChatSummary[] }>> {
  try {
    const db = dbForSlug(input.slug);
    const limit = Math.min(
      LIST_CHATS_MAX_LIMIT,
      Math.max(1, Math.trunc(input.limit ?? LIST_CHATS_DEFAULT_LIMIT)),
    );
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const sql = input.includeArchived
      ? `SELECT ${LIST_CHATS_COLUMNS} FROM agent_chats ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      : `SELECT ${LIST_CHATS_COLUMNS} FROM agent_chats WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const rows = (await db.prepare(sql).all(limit, offset)) as Array<Record<string, unknown>>;
    return { ok: true, data: { chats: rows.map(rowToChatSummary) } };
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
      error: `role must be one of: ${getKnownRoles().join(', ')}`,
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
    const nowMs = Date.now();
    await db
      .prepare('UPDATE agent_chats SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(nowMs, nowMs, input.chatId);
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to archive chat: ${(e as Error).message}` };
  }
}
