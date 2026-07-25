/**
 * unified-conversations — the ONE definition of "a conversation", shared by
 * every surface that renders the curated stream.
 *
 * WHY THIS FILE EXISTS (WI-5754): the unified stream was born inside
 * `adv/AdvConversationsTab.tsx` and, while that was the only surface reading
 * it, living there cost nothing. The left rail's Conversations tab
 * (`left-sidebar/ConversationsTab.tsx`) is a SECOND reader of the same four
 * stores, so the composition rules had to move somewhere both can import —
 * otherwise the two panes drift on the questions that matter most and are
 * least visible: which rows count as conversations, which are hidden as system
 * telemetry, and when two rows are "the same conversation".
 *
 * Everything here is PURE (no React, no fetch state) so it is directly
 * unit-testable and carries no chunk weight into either surface. The four
 * `useSyncQuery` reads stay with their components — this module only says what
 * to do with the rows once they arrive.
 *
 * The row TYPES are the wire shapes of the four `conversations.*List` sync
 * queries (see packages/operator-core/lib/sync-resolver): Q&A questions,
 * coord-thread deliberations, agent-chat sessions, and work-item mail.
 */

// ─── Source row shapes (the four `conversations.*List` sync queries) ─────────

/** `conversations.questionsList` — Q&A questions + discussions. */
export interface ConvRow {
  id: string;
  kind: string;
  state: string;
  scope: string;
  harness_slug: string | null;
  title: string | null;
  asker_id: string;
  topics?: string[];
  promoted_issue_id?: string | null;
  created_ts: string;
  updated_ts?: string;
}

export interface ConvPost {
  id: number;
  author_id: string | null;
  body: string;
  created_ts?: string;
}

/** `conversations.questionDetail`. */
export interface ConvDetailT {
  id: string;
  kind: string;
  state: string;
  scope: string;
  harness_slug?: string | null;
  title: string | null;
  body?: string;
  asker_id?: string;
  accepted_answer?: string | null;
  promoted_issue_id?: string | null;
  topics: string[];
  posts: ConvPost[];
  subscriber_count: number;
}

/** `conversations.deliberationList` — coord:thread / deliberate / vote threads. */
export interface ThreadRow {
  thread_id: string;
  parent_kind: string | null;
  parent_ref: string | null;
  title: string | null;
  created_by: string | null;
  harness_slug: string | null;
  created_at: string;
  last_post_at: string | null;
  post_count: number;
}

export interface ThreadPost {
  id: number;
  author_id: string | null;
  body: string | null;
  created_at: string;
  harness_slug: string | null;
}

/** `conversations.deliberationDetail`. */
export interface DeliberationDetail {
  thread: ThreadRow;
  posts: ThreadPost[];
}

/** `conversations.agentChatList` — multi-turn agent transcripts. */
export interface AgentChatRow {
  id: string;
  harness_slug: string | null;
  role: string | null;
  feature_id: string | null;
  title: string | null;
  created_at: string | number;
  updated_at?: string | number | null;
  archived_at: string | number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  turns: number;
}

export interface AgentChatTurn {
  ts?: string;
  role?: string;
  content?: unknown;
}

/** `conversations.agentChatDetail`. */
export interface AgentChatDetail extends AgentChatRow {
  transcript?: AgentChatTurn[];
}

/** `conversations.messageList` / `messageDetail` — work-item-scoped agent mail. */
export interface MsgRow {
  id: string;
  harness_slug: string | null;
  from_slug: string;
  to_slug: string | null;
  to_role: string | null;
  kind: string;
  subject: string | null;
  body: string | null;
  status: string;
  created_at: string;
  from_feature_id: string | null;
  to_feature_id: string | null;
}

// ─── The unified row ────────────────────────────────────────────────────────

/** The four curated sources. Deliberately NOT the `inbox`/`feed` view ids —
 *  a row always belongs to exactly one materialized store. */
export type ConversationSource = 'threads' | 'deliberations' | 'agentchats' | 'messages';

export interface UnifiedConversationRow {
  /** `${source}:${sourceId}` — stable across list invalidations, so a row that
   *  moves to a new sorted position stays the same DOM node. */
  id: string;
  source: ConversationSource;
  sourceId: string;
  typeLabel: string;
  kind: string;
  state: string;
  title: string;
  preview: string;
  actor?: string;
  recipient?: string;
  harnessSlug?: string | null;
  relatedRef?: string | null;
  count?: number;
  updatedAt: number;
}

/** The human-facing name of each source. Shared so the wide surface's inline
 *  type pill and the rail's stripe label can never disagree about what a
 *  source is called. */
export const SOURCE_LABEL: Record<ConversationSource, string> = {
  threads: 'Questions & discussions',
  deliberations: 'Group decisions',
  agentchats: 'Agent chat',
  messages: 'Work-item mail',
};

// ─── Normalisation + identity ───────────────────────────────────────────────

export function conversationEpoch(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizedConversationText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * System-origin coordination is diagnostic telemetry, not a curated
 * conversation. Every curated source filters through this ONE predicate so the
 * Conversations views and the Raw events view stay a true partition — and so
 * the rail and /adv hide exactly the same rows.
 */
export function isSystemConversationActor(value: string | null | undefined): boolean {
  return /^system(?:$|[-_:/.])/i.test((value ?? '').trim());
}

/**
 * A deliberately strict cross-source signature. Distinct conversations may
 * legitimately share a work-item or a title, so collapse them only when every
 * user-visible identity field matches.
 */
export function unifiedConversationSignature(row: UnifiedConversationRow): string {
  return [
    normalizedConversationText(row.title),
    normalizedConversationText(row.preview),
    normalizedConversationText(row.actor),
    normalizedConversationText(row.recipient),
    normalizedConversationText(row.harnessSlug),
    normalizedConversationText(row.relatedRef),
  ].join('|');
}

// ─── Composition ────────────────────────────────────────────────────────────

/**
 * Compose the unified stream from the four cached list queries, newest first,
 * deduplicated by identity AND by the semantic signature above.
 *
 * A row click therefore remounts onto a warm list cache instead of replacing
 * one aggregate query with a cold request — which is why this takes already
 * fetched arrays rather than doing any fetching of its own.
 */
export function composeUnifiedConversationRows(
  questions: readonly ConvRow[],
  deliberations: readonly ThreadRow[],
  agentChats: readonly AgentChatRow[],
  messages: readonly MsgRow[],
  limit: number,
): UnifiedConversationRow[] {
  const candidates: UnifiedConversationRow[] = [
    ...questions.filter((row) => !isSystemConversationActor(row.asker_id)).map((row) => ({
      id: `threads:${row.id}`,
      source: 'threads' as const,
      sourceId: row.id,
      typeLabel: SOURCE_LABEL.threads,
      kind: row.kind,
      state: row.state,
      title: row.title ?? row.id,
      preview: (row.topics ?? []).map((topic) => `#${topic}`).join('  '),
      actor: row.asker_id,
      harnessSlug: row.harness_slug,
      relatedRef: row.promoted_issue_id,
      updatedAt: conversationEpoch(row.updated_ts ?? row.created_ts),
    })),
    ...deliberations.filter((row) => !isSystemConversationActor(row.created_by)).map((row) => ({
      id: `deliberations:${row.thread_id}`,
      source: 'deliberations' as const,
      sourceId: row.thread_id,
      typeLabel: SOURCE_LABEL.deliberations,
      kind: row.parent_kind ?? '',
      state: '',
      title: row.title ?? row.thread_id,
      preview: [row.parent_kind, row.parent_ref].filter(Boolean).join(' · '),
      actor: row.created_by ?? undefined,
      harnessSlug: row.harness_slug,
      relatedRef: row.parent_ref,
      count: row.post_count,
      updatedAt: conversationEpoch(row.last_post_at ?? row.created_at),
    })),
    ...agentChats.filter((row) => !isSystemConversationActor(row.role)).map((row) => ({
      id: `agentchats:${row.id}`,
      source: 'agentchats' as const,
      sourceId: row.id,
      typeLabel: SOURCE_LABEL.agentchats,
      kind: row.role ?? '',
      state: row.archived_at == null ? 'open' : 'archived',
      title: row.title ?? row.id,
      preview: [row.role, row.feature_id].filter(Boolean).join(' · '),
      actor: row.role ?? undefined,
      harnessSlug: row.harness_slug,
      relatedRef: row.feature_id,
      count: row.turns,
      updatedAt: conversationEpoch(row.updated_at ?? row.created_at),
    })),
    ...messages.filter((row) => !isSystemConversationActor(row.from_slug)).map((row) => ({
      id: `messages:${row.id}`,
      source: 'messages' as const,
      sourceId: row.id,
      typeLabel: SOURCE_LABEL.messages,
      kind: row.kind,
      state: row.status,
      title: row.subject || row.body || row.id,
      preview: row.body ?? '',
      actor: row.from_slug,
      recipient: row.to_slug ?? row.to_role ?? undefined,
      harnessSlug: row.harness_slug,
      relatedRef: row.to_feature_id ?? row.from_feature_id,
      updatedAt: conversationEpoch(row.created_at),
    })),
  ];

  const identities = new Set<string>();
  const semanticRows = new Set<string>();
  const deduplicated: UnifiedConversationRow[] = [];
  for (const row of candidates.sort((a, b) => b.updatedAt - a.updatedAt)) {
    const identity = `${row.source}:${row.sourceId}`;
    const semantic = unifiedConversationSignature(row);
    if (identities.has(identity) || semanticRows.has(semantic)) continue;
    identities.add(identity);
    semanticRows.add(semantic);
    deduplicated.push(row);
    if (deduplicated.length === limit) break;
  }
  return deduplicated;
}

/** Free-text search over everything a row displays. Shared so the rail's
 *  single search box and /adv's search filter the same fields. */
export function conversationMatchesQuery(row: UnifiedConversationRow, query: string): boolean {
  const q = normalizedConversationText(query);
  if (!q) return true;
  return [row.typeLabel, row.kind, row.state, row.title, row.preview, row.actor, row.recipient, row.harnessSlug, row.relatedRef]
    .some((value) => normalizedConversationText(value).includes(q));
}

// ─── Shared transport ───────────────────────────────────────────────────────

/** Reads are bounded; a wedged coordination read must fail rather than hang a pane. */
export const CONVERSATION_READ_TIMEOUT_MS = 15_000;

export function conversationErrText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The audited coordination admin proxy — `POST /api/admin/coordination/:group/:verb`,
 * which re-dispatches into the SAME MCP tool handlers the agents call. Both the
 * rail and /adv write through this one helper, so neither can quietly acquire a
 * second write path.
 */
export async function coordFetch<T = Record<string, unknown>>(
  verb: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const isRead = verb.endsWith('/list') || verb.endsWith('/get');
  const res = await fetch(`/api/admin/coordination/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    ...(isRead ? { signal: AbortSignal.timeout(CONVERSATION_READ_TIMEOUT_MS) } : {}),
  });
  if (!res.ok) throw new Error(`${verb}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ─── Display helpers ────────────────────────────────────────────────────────

/** agent-chat timestamps are bigint epoch-ms; coord/message ones are ISO
 *  strings. Normalise either to a display string. */
export function fmtConversationTs(v: string | number | null | undefined): string {
  if (v == null) return '';
  const d = new Date(typeof v === 'number' ? v : v);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Compact relative age — the rail has room for `3h`, not `3 hours ago`. */
export function fmtConversationRel(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * An agent-chat transcript turn's content is either a plain string or an array
 * of content parts (the provider block shape). Flatten either to text — shared,
 * because both the wide transcript and the rail's render the same turns.
 */
export function turnText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === 'string'
          ? p
          : p && typeof p === 'object' && 'text' in p
            ? String((p as { text: unknown }).text)
            : JSON.stringify(p),
      )
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** The same clock, abbreviated for a 300px row where `ago` does not fit. */
export function fmtConversationAge(v: string | number | null | undefined): string {
  const rel = fmtConversationRel(v);
  return rel.endsWith(' ago') ? rel.slice(0, -4) : rel;
}
