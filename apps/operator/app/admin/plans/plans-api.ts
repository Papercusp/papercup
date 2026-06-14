'use client';

/**
 * Client-side plans:* API + read hooks.
 *
 * P-101 deliverable: typed fetchers and React hooks the rail (P-102),
 * detail view (P-105), search (P-104), and inbox/actionable routes
 * (P-108) consume. All calls go through /api/admin/plans/:verb per
 * D-009 — never directly at the agent-tools catch-all.
 *
 * Per D-008 the model is request/response: fetch on mount + on dep
 * change, plus an explicit `refresh()`. No SSE/live-sync in v1.
 */

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { ReportBlock } from '@papercusp/chat-protocol';

/* ── Wire types — mirror lib/agent-tools/plans/* return shapes ─────── */

export type PlanStatus = 'draft' | 'ready' | 'active' | 'blocked' | 'shipped' | 'superseded';

/**
 * The five lifecycle buckets surfaced as filter tabs in the Plans tab.
 * Every plan maps to exactly one via {@link bucketOf} — the forward
 * lifecycle (draft → ready → running → shipped) plus the `rejected`
 * off-ramp. Distinct from {@link PlanStatus}: `running` is derived from
 * the operational start-state, not a frontmatter status, and legacy
 * plans (no frontmatter status, defaulted to `draft`) fold into `draft`.
 */
export type PlanBucket = 'draft' | 'ready' | 'running' | 'shipped' | 'rejected';

export const PLAN_BUCKETS: ReadonlyArray<{ id: PlanBucket; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'ready', label: 'Ready' },
  { id: 'running', label: 'Running' },
  { id: 'shipped', label: 'Shipped' },
  // The only way a plan lands in the 'rejected' bucket is status:superseded
  // (reject = supersede), so the chip reads "Superseded".
  { id: 'rejected', label: 'Superseded' },
];

const PLAN_BUCKET_IDS: readonly PlanBucket[] = PLAN_BUCKETS.map((b) => b.id);

/**
 * Total bucketing function — first match wins so the result is always
 * exactly one bucket:
 *   1. superseded            → rejected   (terminal off-ramp)
 *   2. shipped               → shipped    (terminal success)
 *   3. startStatus 'started' → running    (operationally running)
 *   4. ready | active        → ready      (approved, not started; `active` is legacy-approved)
 *   5. otherwise             → draft      (draft, blocked, anything else)
 */
export function bucketOf(plan: Pick<PlanListRow, 'status' | 'startStatus'>): PlanBucket {
  if (plan.status === 'superseded') return 'rejected';
  if (plan.status === 'shipped') return 'shipped';
  if (plan.startStatus === 'started') return 'running';
  if (plan.status === 'ready' || plan.status === 'active') return 'ready';
  return 'draft';
}
export type ItemStatus = 'todo' | 'wip' | 'blocked' | 'needs-human' | 'done' | 'dropped';

/** Per-item importance — a 4th axis orthogonal to status. Mirrors
 *  @papercusp/plan-parser's IMPORTANCE_LEVELS; kept local here per this
 *  module's decoupled wire-type pattern. Ordered most → least. */
export type Importance = 'urgent' | 'high' | 'normal' | 'low';
export const IMPORTANCE_LEVELS: readonly Importance[] = ['urgent', 'high', 'normal', 'low'];
export type PlanStartStatus = 'started' | 'paused' | 'done' | null;

export interface PlanListRow {
  slug: string;
  title: string | null;
  status: PlanStatus;
  /** Last REAL activity on the plan — the PG `updated_at` write timestamp
   *  (ISO), guarded server-side against no-op bumps. Falls back to the
   *  authored frontmatter date on rows a stale server serializes. */
  updated: string | null;
  /** Frontmatter created date — null when the plan never set one.
   *  (May arrive undefined from a server predating the field.) */
  created: string | null;
  owner: string | null;
  archived: boolean;
  isLegacy: boolean;
  itemCounts: Partial<Record<ItemStatus | 'unknown', number>> | null;
  nextAction: string | null;
  /**
   * Resolved harness slug for the plan — per
   * `plans-newbutton-and-subharness-scope-2026-05-25` P-022. Always
   * present (the server resolver falls back to the workspace primary
   * when no ctx harness is provided).
   */
  harness: string;
  /** Operational start state — null means never started. */
  startStatus: PlanStartStatus;
  /** Cross-plan dispatch rank — lower = dispatched first. Null = no explicit priority (uses started_at order). */
  priority: number | null;
  /** Importance of the plan's hottest OPEN item (done/dropped excluded);
   *  null when no items are open. Items without an `importance:` keyword
   *  count as 'normal'. (Undefined from a server predating the field.) */
  maxImportance: Importance | null;
  /** 'scout' when the Scout loop routed this plan (ledger-derived server-side).
   *  (May arrive undefined from a server predating the field.) */
  origin?: 'scout' | null;
}

export interface PlanItem {
  id: string;
  storedStatus: ItemStatus;
  effectiveStatus: ItemStatus;
  text: string;
  /** 4th axis — urgent|high|normal|low. Surfaced as a row badge + sort key. */
  importance?: Importance;
  blockedBy?: string[];
  decisionRefs?: string[];
  phase?: string | null;
  lineNumber?: number;
}

/**
 * `plans:items` returns rows that carry the parent plan's slug — the
 * cross-plan use cases (inbox, actionable) need to know which plan
 * each item came from.
 */
export interface PlanItemRow {
  plan: string;
  archived: boolean;
  item: PlanItem;
}

/* ── Attention feed (plans:attention) — wire types mirroring
   lib/attention/types.ts, kept local per this module's decoupling. ── */

export type AttentionKind =
  | 'plan-item'
  | 'coord-escalation'
  | 'coord-message'
  | 'smoke-fail'
  | 'operator-report'
  // B-14 / P-100 folded disposition channels (D-011):
  | 'improvement'
  | 'standing-approval'
  | 'conversation'
  | 'scout-grade';

export type AttentionActionId =
  | 'chat'
  | 'message-owner'
  | 'resolve'
  | 'mark-done'
  | 'answer'
  | 'drop'
  | 'view-log'
  | 'open'
  | 'ack'
  // B-14 / D-027 follow-on (1): inline disposition for the folded kinds
  // (standing-approval grant/dismiss). Mirrors AttentionActionId in
  // operator-core/lib/attention/types.ts — keep in sync.
  | 'grant'
  | 'dismiss';

/** The four inbox tiers (inbox-tiering-and-message-agent D-002/D-006), ordered
 *  Decisions ▸ Handled-by-operator ▸ Alerts ▸ Activity. Mirrors the server
 *  `AttentionTier`; only `decision` demands the user. */
export type AttentionTier = 'decision' | 'handled' | 'alert' | 'activity';

export const ATTENTION_TIERS: readonly AttentionTier[] = ['decision', 'handled', 'alert', 'activity'];

export const TIER_LABEL: Record<AttentionTier, string> = {
  decision: 'Decisions',
  handled: 'Handled by operator',
  alert: 'Alerts',
  activity: 'Activity',
};

export type TriageState = 'untriaged' | 'confirmed' | 'escalated' | 'downgraded' | 'resolved';

export interface AttentionAction {
  id: AttentionActionId;
  label: string;
  primary?: boolean;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  source: string;
  harnessSlug: string | null;
  planSlug: string | null;
  itemRef: string | null;
  title: string;
  body: string;
  status: string;
  importance: Importance;
  /** Which inbox tier this belongs to (D-002/D-006). */
  tier: AttentionTier;
  needsHuman: boolean;
  /** The owning agent (the coord record's `from`), drives "Message owner". */
  ownerAgentId: string | null;
  ownerLabel: string | null;
  /** Operator-triage overlay (D-006). */
  triageState: TriageState;
  triageNote: string | null;
  triagedBy: string | null;
  triagedAt: string | null;
  actions: AttentionAction[];
  ref: { kind: AttentionKind } & Record<string, unknown>;
  /** Structured report payload (kind `operator-report` only) — the shared
   *  ReportBlock the detail pane renders natively via ReportBlockCard.
   *  report-cards-inbox-reconciliation-2026-06-05 D-001/D-003. */
  report?: ReportBlock;
}

export interface AttentionGroup {
  key: string;
  kind: 'plan' | 'alerts';
  planSlug: string | null;
  harnessSlug: string | null;
  title: string;
  items: AttentionItem[];
  maxImportance: Importance;
}

/** Per-tier counts the reader returns alongside `groups` (for badges). */
export type TierCounts = Record<AttentionTier, number>;

export interface PlanDecision {
  id: string;
  title?: string | null;
  date?: string | null;
  body?: string;
  lineNumber?: number;
}

export interface PlanGetResult {
  slug: string;
  archived: boolean;
  legacy: boolean;
  frontmatter?: Record<string, unknown>;
  now?: { state: string | null; next: string | null } | null;
  items?: PlanItem[];
  decisions?: PlanDecision[];
  missingRefs?: string[];
  cycleMembers?: string[];
  prose?: string;
  /** Full canonical markdown source — fed straight to PlanEditor. */
  raw?: string;
  /** Server-computed hash of `raw`. Legacy CAS baseline (equivalent to
   *  `version`); kept for callers that still send expectedHash. */
  contentHash?: string;
  /** Optimistic-CAS baseline — the plan row's `version` (plans-pg-canonical
   *  D-005). Echoed back as `expectedVersion` on a set-content write. */
  version?: number;
  filename?: string;
  error?: string;
  /** P-006: Map of plan-item-id → { featureId, status }. Present when the
   *  plan has features promoted from it; absent for legacy / no-features plans. */
  linkedFeatures?: Record<string, { featureId: string; status: string }>;
  /** P-083: per-plan-item test coverage (plan↔test rollup via the VAL). */
  planItemTests?: Record<
    string,
    { valsTotal: number; valsRequiringTest: number; valsCovered: number; valsPassing: number }
  >;
}

export type SearchScope = 'title' | 'now' | 'items' | 'decisions' | 'prose';

export interface SearchMatch {
  scope: SearchScope;
  snippet: string;
}

/**
 * `plans:search` returns one hit per plan; each carries every per-scope
 * match it found, with the server-side score the result was sorted on.
 */
export interface PlanSearchHit {
  plan: string;
  score: number;
  matches: SearchMatch[];
}

/* ── Fetchers ──────────────────────────────────────────────────────── */

const BASE = '/api/admin/plans';

async function getJson<T>(
  verb: string,
  params?: Record<string, string | boolean | readonly string[] | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(`${BASE}/${verb}`, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        // Repeated params → bodyFromSearchParams (admin/_plans-args.ts)
        // collapses repeated keys into string[]. Lets us pass
        // `harness_slugs: ['a', 'b']` as `?harness_slugs=a&harness_slugs=b`
        // without changing the admin route.
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const r = await fetch(url.toString(), signal ? { signal } : undefined);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`plans:${verb} → ${r.status}: ${text.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

async function postJson<T>(verb: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${BASE}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`plans:${verb} → ${r.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`plans:${verb} → non-JSON response: ${text.slice(0, 200)}`);
  }
}

export function fetchPlanList(params?: {
  status?: PlanStatus;
  includeArchived?: boolean;
  includeLegacy?: boolean;
  /** P-029: fan out across multiple harnesses. */
  harness_slugs?: readonly string[];
}, signal?: AbortSignal) {
  return getJson<{ plans: PlanListRow[] }>('list', params, signal);
}

export function fetchPlan(slug: string, signal?: AbortSignal) {
  // mode:'full' is REQUIRED here. `plans:get` defaults to mode:'sections',
  // which returns frontmatter + items + a section INDEX but NOT the prose/raw
  // markdown body (the default protects agent payloads from a 90KB blob —
  // plans-pg-canonical-migration-2026-06-03). The UI consumers of usePlan
  // (PlanDetail's Vditor editor, PlanItemPreview) and rejectDraftPlan all read
  // `data.raw`/`data.prose` to render/round-trip the whole plan, so without
  // mode:'full' the editor renders BLANK. These are user-driven, one-plan-at-
  // a-time fetches, so the full body is the right payload.
  return getJson<PlanGetResult>('get', { slug, mode: 'full' }, signal);
}

export function fetchPlanItems(params?: {
  slug?: string;
  status?: ItemStatus;
  actionable?: boolean;
  needsHuman?: boolean;
}) {
  return getJson<{ items: PlanItemRow[] }>('items', params);
}

export function searchPlans(params: { query: string }) {
  return getJson<{ hits: PlanSearchHit[] }>('search', params);
}

export function fetchPlanAttention(params?: { harnessSlug?: string; includeArchived?: boolean }) {
  return getJson<{ groups: AttentionGroup[]; tierCounts?: TierCounts }>('attention', params);
}

/* ── Other-item actions (coord:* via the /api/admin/coord proxy) ─────── */

async function postCoord<T>(verb: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`/api/admin/coord/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`coord:${verb} → ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

/** Resolve a coord escalation by msg_id, recording the chosen option id. */
export function resolveEscalation(args: { msg_id: string; choice: string; note?: string }) {
  return postCoord<{ ok?: boolean; error?: string }>('resolve', args);
}

/** Acknowledge a coord message addressed to the human. */
export function ackCoordMessage(args: { msg_id: string }) {
  return postCoord<{ ok?: boolean; error?: string }>('ack', args);
}

/** Triage an attention item (inbox:triage via the /api/admin/inbox proxy).
 *  Resolving an operator-report from the inbox IS the triage state machine
 *  (resolve → handled tier, auditable). report-cards-inbox-reconciliation P-007. */
export async function triageAttentionItem(args: {
  itemId: string;
  action: 'confirm' | 'escalate' | 'downgrade' | 'resolve';
  note?: string;
}): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/api/admin/inbox/triage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`inbox:triage → ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    return {};
  }
}

/* ── "Message owner" + inline conversation thread (Brief 21, D-004) ──────
 *  message-agent goes through the /api/admin/coord proxy (this brief owns it);
 *  the thread is read/posted through the /api/admin/coordination proxy
 *  (conversations:* — shared with Brief 25's conversations tab). */

export interface MessageOwnerArgs {
  /** The owning agent's ownerId (omit for a harness-scoped thread with no owner). */
  to?: string | null;
  body: string;
  title?: string;
  harness?: string | null;
  plan_slug?: string | null;
  item_ref?: string | null;
  topics?: string[];
}

export interface MessageOwnerResult {
  ok?: boolean;
  conversation_id?: string;
  thread_id?: string;
  to?: string | null;
  error?: string;
}

/** Open a work-item-scoped conversation with the item's owning agent. */
export function messageOwner(args: MessageOwnerArgs) {
  return postCoord<MessageOwnerResult>('message-agent', {
    ...(args.to ? { to: args.to } : {}),
    body: args.body,
    ...(args.title ? { title: args.title } : {}),
    ...(args.harness ? { harness: args.harness } : {}),
    ...(args.plan_slug ? { plan_slug: args.plan_slug } : {}),
    ...(args.item_ref ? { item_ref: args.item_ref } : {}),
    ...(args.topics?.length ? { topics: args.topics } : {}),
  });
}

async function postCoordination<T>(group: string, verb: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`/api/admin/coordination/${group}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`coordination:${group}/${verb} → ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

export interface ConversationPost {
  id: number;
  author_id: string;
  body: string;
  created_ts: string;
}

export interface ConversationDetail {
  conversation: {
    id: string;
    kind: string;
    state: string;
    title: string | null;
    body: string;
    asker_id: string;
    harness_slug: string | null;
    promoted_issue_id?: string | null;
  };
  topics: string[];
  posts: ConversationPost[];
  subscriber_count: number;
}

/** Read a conversation thread (the inline thread view). */
export function getConversation(conversationId: string) {
  return postCoordination<ConversationDetail | { error: string }>('conversations', 'get', {
    conversation_id: conversationId,
  });
}

/** Post a reply into a conversation thread (as the human/admin identity). */
export function postConversation(conversationId: string, body: string) {
  return postCoordination<{ ok?: boolean; post_id?: number; error?: string }>('conversations', 'post', {
    conversation_id: conversationId,
    body,
  });
}

/** Answer + close an open question from the Queue (D-027 follow-on (1)): record
 *  the owner's text as the accepted answer and resolve the conversation, which
 *  captures it to the knowledge layer (for the next asker) and drops it from the
 *  Queue. The owner is the authority, so answering IS resolving — distinct from
 *  postConversation (a non-closing reply). */
export function resolveConversationAnswer(args: { conversation_id: string; accepted_answer: string }) {
  return postCoordination<{ ok?: boolean; state?: string; error?: string }>('conversations', 'resolve', {
    conversation_id: args.conversation_id,
    accepted_answer: args.accepted_answer,
  });
}

/** Dismiss a routed improvement from the Queue (D-027 follow-on (1)): triage-one
 *  reject — closes the idea and records the decision so the recall matcher surfaces
 *  "already decided" on the next same-signature capture. Accepting/routing
 *  (place/gate/gym) stays on the full Triage surface (the navigate `open`). */
export function dismissImprovement(issueId: string) {
  return postCoordination<{ ok?: boolean; closed?: boolean; error?: string }>('improvements', 'triage', {
    mode: 'triage-one',
    ideaId: issueId,
    decision: 'reject',
    reason: 'Dismissed from the Queue by the owner',
  });
}

/** Grant or dismiss a standing-approval candidate from the Queue (D-027 follow-on
 *  (1)). Mirrors the settings/operator page's decideCandidate — the same POST half
 *  of operator:standing_approvals_decide; Grant writes the [STANDING-APPROVE]
 *  preference entry, both refresh candidates so the pair drops out. */
export async function decideStandingApproval(args: {
  capability: string;
  targetHarness: string;
  decision: 'approve' | 'dismiss';
}): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/api/agent-mcp/operator-standing-approvals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`standing-approvals:decide → ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    return {};
  }
}

/* ── Hooks ─────────────────────────────────────────────────────────── */

export interface AsyncResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Patch cached data in place (optimistic updates) without a refetch. */
  setData?: Dispatch<SetStateAction<T | null>>;
}

function useAsyncJson<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Abort the in-flight request when deps change or the component unmounts.
    // Without this, rapidly switching plans/items leaves superseded fetches
    // holding open connections; under the webview's ~6-per-origin HTTP/1.1 cap
    // they pile up and the next plan GET queues indefinitely — the "loading
    // plan forever (until refresh)" wedge. Aborting frees the connection at once.
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher(controller.signal)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        // An aborted fetch (superseded selection / unmount) is expected, not an error.
        if (!cancelled && (e as { name?: string })?.name !== 'AbortError') {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1), setData };
}

/**
 * Adapt `useSyncQuery` (shared `['sync', name, args]` cache + PG-NOTIFY →
 * SSE invalidation) to the `AsyncResult<{ [key]: T[] }>` shape the plans
 * consumers already expect.
 *
 * Create-tab live-query migration (2026-06-03): the four cross-cutting plan
 * reads (list / items / attention / search) move off the bespoke
 * `useAsyncJson` (per-call-site `useState`, no shared cache, manual
 * `refresh()`) onto the shared sync layer. Two readers of the same query
 * now share ONE cache entry, and a `plans:*` write invalidates every
 * subscriber server-side — so the old `refreshItems()` fan-out closure is
 * unnecessary, which is what lets the Create tab split into independent
 * dock panels (P2).
 */
function useSyncResource<T, K extends string>(
  queryName: string,
  args: Record<string, unknown>,
  key: K,
  enabled = true,
): AsyncResult<Record<K, T[]>> {
  const r = useSyncQuery<T>({ queryName, args, enabled });
  const rows: T[] = enabled ? (r.data ?? []) : [];
  const data = useMemo(() => ({ [key]: rows }) as Record<K, T[]>, [key, rows]);
  return {
    data,
    loading: r.loading,
    error: r.error ? r.error.message : null,
    refresh: () => r.invalidate(),
  };
}

/** Like {@link useSyncResource} but returns the row array directly (for
 *  hooks whose consumers expect `AsyncResult<T[]>`, not `{ key: T[] }`). */
function useSyncRows<T>(
  queryName: string,
  args: Record<string, unknown>,
  enabled = true,
): AsyncResult<T[]> {
  const r = useSyncQuery<T>({ queryName, args, enabled });
  const data: T[] = enabled ? (r.data ?? []) : [];
  return {
    data,
    loading: r.loading,
    error: r.error ? r.error.message : null,
    refresh: () => r.invalidate(),
  };
}

export function usePlanList(params?: {
  status?: PlanStatus;
  includeArchived?: boolean;
  includeLegacy?: boolean;
  /** P-029: fan out across multiple harnesses. Pass undefined to use
   *  the ctx-resolved single harness. */
  harness_slugs?: readonly string[];
}): AsyncResult<{ plans: PlanListRow[] }> {
  // Stable join so a same-content array doesn't churn the query key.
  const harnessSlugsKey = params?.harness_slugs?.slice().sort().join('|') ?? '';
  const args = useMemo<Record<string, unknown>>(
    () => ({
      ...(params?.status ? { status: params.status } : {}),
      ...(params?.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {}),
      ...(params?.includeLegacy !== undefined ? { includeLegacy: params.includeLegacy } : {}),
      ...(params?.harness_slugs ? { harness_slugs: [...params.harness_slugs] } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params?.status, params?.includeArchived, params?.includeLegacy, harnessSlugsKey],
  );
  return useSyncResource<PlanListRow, 'plans'>('plans.list', args, 'plans');
}

const EMPTY_ARGS: Record<string, unknown> = {};

/**
 * The current viewer's plan-owner email (git config user.email), for the
 * "my / others' / all" owner saved-views (shared-hive-collaboration P-002).
 * null while loading or when the identity can't be resolved (then mine/others
 * degrade to showing all). Shared sync cache — calling this in several
 * components dedupes to one query.
 */
export function usePlanViewerEmail(): string | null {
  const r = useSyncRows<{ email: string | null }>('plans.viewer', EMPTY_ARGS);
  return r.data?.[0]?.email ?? null;
}

export function usePlan(slug: string | null) {
  return useAsyncJson<PlanGetResult | null>(
    (signal) => (slug ? fetchPlan(slug, signal) : Promise.resolve(null)),
    [slug],
  );
}

export function usePlanItems(params?: {
  slug?: string;
  status?: ItemStatus;
  actionable?: boolean;
  needsHuman?: boolean;
  /** Skip the fetch (return empty) when false — lets a caller mount the
   *  hook unconditionally but only hit the network for the active view. */
  enabled?: boolean;
}): AsyncResult<{ items: PlanItemRow[] }> {
  const enabled = params?.enabled ?? true;
  const args = useMemo<Record<string, unknown>>(
    () => ({
      ...(params?.slug ? { slug: params.slug } : {}),
      ...(params?.status ? { status: params.status } : {}),
      ...(params?.actionable !== undefined ? { actionable: params.actionable } : {}),
      ...(params?.needsHuman !== undefined ? { needsHuman: params.needsHuman } : {}),
    }),
    [params?.slug, params?.status, params?.actionable, params?.needsHuman],
  );
  return useSyncResource<PlanItemRow, 'items'>('plans.items', args, 'items', enabled);
}

export function usePlanAttention(params?: {
  harnessSlug?: string;
  includeArchived?: boolean;
  enabled?: boolean;
}): AsyncResult<{ groups: AttentionGroup[] }> {
  const enabled = params?.enabled ?? true;
  const args = useMemo<Record<string, unknown>>(
    () => ({
      ...(params?.harnessSlug ? { harnessSlug: params.harnessSlug } : {}),
      ...(params?.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {}),
    }),
    [params?.harnessSlug, params?.includeArchived],
  );
  return useSyncResource<AttentionGroup, 'groups'>('plans.attention', args, 'groups', enabled);
}

export function usePlanSearch(query: string): AsyncResult<{ hits: PlanSearchHit[] }> {
  const q = query.trim();
  const args = useMemo<Record<string, unknown>>(() => ({ query: q }), [q]);
  return useSyncResource<PlanSearchHit, 'hits'>('plans.search', args, 'hits', q.length > 0);
}

/* ── Write fetchers (P-201) ────────────────────────────────────────── */

/** Result envelope every assisted-write verb returns through the MCP
 *  text channel:
 *
 *    Success → `{ ok: true, ...payload, filePath }`
 *    Domain failure → `{ error: '<code>', slug, ... }`  (NOT `{ ok: false }`)
 *    Lock conflict → `{ error: 'busy', busy: [{ owner_label, intent }] }`
 *
 *  Note: domain failures use the `error` key (string), not
 *  `ok: false`. Earlier drafts of this client assumed an
 *  `{ ok: false, code }` shape — verified against
 *  apps/operator/lib/agent-tools/plans/*.ts and corrected. */
export type WriteResult<TPayload = unknown> =
  | ({ ok: true; filePath?: string } & TPayload)
  | { error: string; busy?: Array<{ owner_label?: string; intent?: string }>; [k: string]: unknown };

export interface SetStatusArgs {
  slug: string;
  itemId: string;
  status: ItemStatus;
  note?: string;
}

export interface SetNowArgs {
  slug: string;
  state: string;
  next: string;
}

export interface AddDecisionArgs {
  slug: string;
  title: string;
  body: string;
  refs?: string[];
  affects?: string[];
}

export interface AddItemArgs {
  slug: string;
  phase: string;
  text: string;
  blockedBy?: string[];
  /** Required by plans:add-item — urgent|high|normal|low. */
  importance: Importance;
}

export interface NewPlanArgs {
  slug: string;
  title: string;
  status?: PlanStatus;
  owner?: string;
}

export interface LintArgs {
  slug?: string;
  includeArchived?: boolean;
}

export interface LintFinding {
  level: 'error' | 'warning';
  code: string;
  message: string;
  itemId?: string;
  decisionId?: string;
}

export interface PlanLintReport {
  slug: string;
  archived: boolean;
  legacy: boolean;
  exempt: boolean;
  errors: LintFinding[];
  warnings: LintFinding[];
}

export function setItemStatus(args: SetStatusArgs) {
  return postJson<WriteResult<{ oldStatus: ItemStatus; newStatus: ItemStatus; itemId: string }>>(
    'set-status',
    args as unknown as Record<string, unknown>,
  );
}

export function setPlanNow(args: SetNowArgs) {
  return postJson<WriteResult>('set-now', args as unknown as Record<string, unknown>);
}

export function addPlanDecision(args: AddDecisionArgs) {
  return postJson<WriteResult<{ decisionId: string; slug: string }>>(
    'add-decision',
    args as unknown as Record<string, unknown>,
  );
}

export function addPlanItem(args: AddItemArgs) {
  return postJson<WriteResult<{ itemId: string; createdPhase: boolean; slug: string }>>(
    'add-item',
    args as unknown as Record<string, unknown>,
  );
}

export function createPlan(args: NewPlanArgs) {
  return postJson<WriteResult<{ slug: string }>>('new', args as unknown as Record<string, unknown>);
}

/**
 * Apply a `promote:plan` fenced block emitted by the architect.
 * Server-side wraps the full plans:new → set-now → add-item × N →
 * add-decision × N sequence (plan-block-handler.ts).
 *
 * Single round-trip from the client; the server holds the lock once
 * and applies all writes atomically from the client's perspective.
 * Returns `{ ok: true, slug }` on success.
 *
 * Pass `harnessSlug` when calling from a harness-scoped UI so the
 * admin route invalidates that harness's `plansDrafts.bySlug`
 * subscription — the new draft card then appears in ProposalsPanel
 * without waiting for a manual refresh.
 */
export function applyPlanBlock(args: { blockContent: string; harnessSlug?: string }) {
  return postJson<WriteResult<{ slug: string }>>(
    'apply-plan-block',
    args as unknown as Record<string, unknown>,
  );
}

/* ── Phase 3 write verbs (P-301 / P-302, D-011) ────────────────────── */

/** Plan-frontmatter statuses that can be *written* — the parser-
 *  synthesized `unknown` and the item-only `blocked` are excluded. */
export type PromotablePlanStatus = 'draft' | 'active' | 'shipped' | 'superseded';
export const PROMOTABLE_PLAN_STATUSES: PromotablePlanStatus[] = [
  'draft', 'active', 'shipped', 'superseded',
];

export interface SetContentArgs {
  slug: string;
  content: string;
  /** Optimistic-CAS baseline — the plan row's `version` from the plans:get that
   *  loaded the editor (plans-pg-canonical D-005). Preferred over expectedHash. */
  expectedVersion?: number;
  /** Legacy CAS baseline (the `contentHash` from plans:get) — equivalent to
   *  expectedVersion; kept for back-compat. */
  expectedHash?: string;
  /** plan-agent-launch P-025 (D-009): the "what changed & why" the
   *  editor's Save flow collects. Carried through to the new
   *  plan_revisions row, where it becomes the always-loaded
   *  rationale for any agent later launched from this plan. Optional
   *  per D-009 — expectation scales with the write's significance. */
  rationale?: string;
}

export interface PromoteArgs {
  slug: string;
  title: string;
  status: PromotablePlanStatus;
  created?: string;
  owner?: string;
}

/**
 * Wire verb for legacy-plan frontmatter conversion.
 *
 * D-011 originally floated the name `plans:promote`, but that name is
 * ALREADY TAKEN — `coordination/tools/promote.ts` registers a
 * `plans:promote` tool that promotes a plan *into a harness*
 * (`harness_slug` + `features[]`). The two operations are unrelated;
 * `agent-plan-tracking` Phase 5 must therefore register the
 * frontmatter writer under a different name. `set-frontmatter` is the
 * alternative the D-011 owner already offered, and it matches the
 * `set-status` / `set-now` / `set-content` family. The UI keeps the
 * user-facing word "promote" (a legacy plan is promoted to a real
 * one); only the tool verb differs.
 */
const PROMOTE_VERB = 'set-frontmatter';

/**
 * `plans:set-content` result. Three shapes (D-011):
 *   - success      → { ok: true, slug?, contentHash? }
 *   - stale (CAS)  → { code|error: 'stale', currentContent, currentHash? }
 *   - lint failure → { code|error: <code>, errors: LintFinding[] }
 * The `code` vs `error` key is read defensively because the owner's
 * sketch used `code` while the existing verbs use `error` — whichever
 * Phase 5 ships, `staleConflictOf` / `writeErrorOf` handle it.
 */
export type SetContentResult =
  | { ok: true; slug?: string; filePath?: string; contentHash?: string; version?: number }
  | {
      ok?: false;
      code?: string;
      error?: string;
      currentContent?: string;
      currentHash?: string;
      currentVersion?: number;
      errors?: LintFinding[];
      [k: string]: unknown;
    };

export interface StaleConflict {
  currentContent: string;
  currentHash?: string;
}

/** Extract a CAS-stale conflict from a set-content result, or null. */
export function staleConflictOf(r: SetContentResult): StaleConflict | null {
  if (r && typeof r === 'object' && !('ok' in r && r.ok)) {
    const o = r as Record<string, unknown>;
    const code = o.code ?? o.error;
    if (code === 'stale' && typeof o.currentContent === 'string') {
      return {
        currentContent: o.currentContent,
        currentHash: typeof o.currentHash === 'string' ? o.currentHash : undefined,
      };
    }
  }
  return null;
}

/** Human-readable error from a set-content result, or null on success
 *  / on a stale conflict (callers handle stale separately). */
export function writeErrorOf(r: SetContentResult): string | null {
  if (r && typeof r === 'object') {
    if ('ok' in r && r.ok) return null;
    const o = r as Record<string, unknown>;
    const code = (o.code ?? o.error) as string | undefined;
    if (code === 'stale') return null;
    if (Array.isArray(o.errors) && o.errors.length) {
      const fs = o.errors as LintFinding[];
      return `lint failed — ${fs.map((f) => f.code).join(', ')}`;
    }
    if (typeof code === 'string') return code;
  }
  return 'unexpected response shape';
}

export function setPlanContent(args: SetContentArgs) {
  return postJson<SetContentResult>('set-content', args as unknown as Record<string, unknown>);
}

export function promotePlan(args: PromoteArgs) {
  return postJson<WriteResult<{ slug: string }>>(
    PROMOTE_VERB,
    args as unknown as Record<string, unknown>,
  );
}

export interface PromoteToHarnessFeature {
  title: string;
  from_items?: string[];
}

export interface PromoteToHarnessArgs {
  slug: string;
  harness_slug: string;
  features: PromoteToHarnessFeature[];
  apply: boolean;
}

export interface PromoteToHarnessResult {
  ok: boolean;
  features_created?: number;
  ids?: string[];
  error?: string;
}

export function promoteToHarness(args: PromoteToHarnessArgs) {
  return postJson<PromoteToHarnessResult>('promote', args as unknown as Record<string, unknown>);
}

/**
 * Reject a draft plan: flip status → superseded via CAS set-content.
 * The plansDrafts.bySlug resolver filters out non-draft plans, so the
 * card disappears from ProposalsPanel immediately after this resolves.
 */
/**
 * Reject (i.e. supersede) a draft plan. Flips `status: draft` →
 * `status: superseded` via a CAS set-content call.
 *
 * Pass `harnessSlug` from the calling UI so the admin route can
 * invalidate that harness's `plansDrafts.bySlug` subscription —
 * otherwise the card lingers in ProposalsPanel until next refresh.
 * Server reads it from `body.harness_slug` (also accepts the URL
 * `?harness=` form); set-content's argsSchema strips the unknown
 * key, so it's purely a routing hint.
 */
export async function rejectDraftPlan(
  slug: string,
  harnessSlug?: string,
): Promise<{ ok: boolean; error?: string }> {
  const plan = await fetchPlan(slug);
  if ('error' in plan && plan.error) return { ok: false, error: plan.error };
  const raw = plan.raw;
  if (!raw) return { ok: false, error: 'no_content' };
  // Reject = supersede. Works on any non-terminal plan (draft / ready /
  // active / blocked), not just drafts — so the "Reject Plan" button can
  // sit next to Start for approved/running plans. shipped + superseded
  // are terminal and left untouched.
  const updated = raw.replace(/^(status:\s*)(?:draft|ready|active|blocked)\b/m, '$1superseded');
  if (updated === raw) return { ok: false, error: 'status_not_rejectable' };
  const res = await setPlanContent({
    slug,
    // version CAS (D-005); expectedHash kept as a fallback for an older server.
    expectedVersion: plan.version,
    expectedHash: plan.contentHash,
    content: updated,
    ...(harnessSlug && { harness_slug: harnessSlug }),
  } as SetContentArgs & { harness_slug?: string });
  if ('ok' in res && res.ok) return { ok: true };
  return { ok: false, error: writeErrorOf(res) ?? 'set_content_failed' };
}

/**
 * Drive the first-class `plans:set-plan-status` verb — the single
 * server-side source of truth for plan-level lifecycle flips (the same
 * verb agents call). The server does the frontmatter read-modify-write
 * inside the SU lock and emits the `status_changed` plan-event, so the
 * client no longer carries its own CAS/regex. `expectedCurrent` is an
 * optional transition guard. Returns the UI's `{ ok, error }` shape.
 */
async function setPlanStatusVerb(
  slug: string,
  status: 'draft' | 'ready' | 'shipped' | 'superseded',
  opts: { expectedCurrent?: PlanStatus; harnessSlug?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await postJson<{ ok?: boolean; code?: string; error?: string }>('set-plan-status', {
      slug,
      status,
      ...(opts.expectedCurrent ? { expectedCurrent: opts.expectedCurrent } : {}),
      ...(opts.harnessSlug ? { harness_slug: opts.harnessSlug } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.code ?? r.error ?? 'set_plan_status_failed' };
  } catch (e) {
    // busy (lock conflict) → non-2xx → postJson throws; surface it.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Approve a draft plan (draft → ready) via plans:set-plan-status.
 * Approval is the human gate that unlocks the Start button — it does NOT
 * start the plan. Guarded on `draft` so it never overwrites a non-draft.
 */
export function approvePlan(slug: string, harnessSlug?: string) {
  return setPlanStatusVerb(slug, 'ready', { expectedCurrent: 'draft', harnessSlug });
}

/**
 * Demote an approved plan back to draft (ready/active → draft) via
 * plans:set-plan-status. Reverses {@link approvePlan}. Unguarded — the
 * Demote button only renders for the ready bucket, so the current status
 * is already ready/active.
 */
export function demotePlanToDraft(slug: string, harnessSlug?: string) {
  return setPlanStatusVerb(slug, 'draft', { harnessSlug });
}

export function startPlan(slug: string) {
  return postJson<{ slug: string; harnessSlug: string; status: string }>('start', { slug });
}

export function pausePlan(slug: string) {
  return postJson<{ slug: string; harnessSlug: string; status?: string; notStarted?: boolean }>(
    'pause',
    { slug },
  );
}

/** Set cross-plan dispatch priority for a started plan (P-045/D-013). */
export function setPlanPriority(slug: string, priority: number | null) {
  return postJson<{ ok: boolean; slug: string; priority: number | null }>(
    'set-priority',
    { slug, priority },
  );
}

export function lintPlan(args: LintArgs = {}) {
  // lint is a read (GET) but logically a write-time companion (called
  // after assisted writes); expose it next to the writers so call sites
  // import from one place. Returns `{ reports: [...] }` on success or
  // `{ error: '<code>', slug }` when the slug is unknown.
  return getJson<{ reports: PlanLintReport[] } | { error: string; slug?: string }>('lint', {
    slug: args.slug,
    includeArchived: args.includeArchived,
  });
}

/* ── Lock queue (P-205) ────────────────────────────────────────────── */

export interface ActiveLock {
  path: string;
  owner: string;
  owner_label: string | null;
  intent: string;
  acquired_ts: string; // ISO
  expires_ts: string;  // ISO
}

export interface LockQueueResult {
  active_locks: ActiveLock[];
  waiting?: unknown[];
}

const PLANS_DIR_REL = 'apps/operator/docs/plans';

/** Workspace-relative lock key matching what with-plan-lock.ts uses
 *  (apps/operator/docs/plans/[archive/]<slug>.md, POSIX). */
export function planLockPath(slug: string, archived: boolean): string {
  return archived
    ? `${PLANS_DIR_REL}/archive/${slug}.md`
    : `${PLANS_DIR_REL}/${slug}.md`;
}

async function fetchLockQueue(paths: string[]): Promise<LockQueueResult> {
  const url = new URL('/api/admin/locks/queue', window.location.origin);
  for (const p of paths) url.searchParams.append('paths', p);
  const r = await fetch(url.toString());
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`locks:queue → ${r.status}: ${text.slice(0, 200)}`);
  }
  return (await r.json()) as LockQueueResult;
}

/**
 * Poll the lock queue for one plan's path. Re-fetches on slug change,
 * on document focus / visibility-change, and on a 30s timer while
 * visible. Per D-008 (no SSE/live-sync) and the lock-banner spec
 * (P-205). Returns the matching active lock or null.
 */
export function usePlanLock(
  slug: string | null,
  archived: boolean,
): AsyncResult<ActiveLock | null> {
  const [data, setData] = useState<ActiveLock | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!slug) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const lockPath = planLockPath(slug, archived);
    const poll = async () => {
      setLoading(true);
      try {
        const res = await fetchLockQueue([lockPath]);
        if (cancelled) return;
        const hit = res.active_locks.find((l) => l.path === lockPath) ?? null;
        setData(hit);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    poll();
    const onFocus = () => poll();
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, archived, tick]);

  return { data, loading, error, refresh };
}

/* ── plan_revisions (plan-agent-launch P-004 / P-017) ──────────────── */
/* The git-history surface (P-303) was removed when plans went PG-canonical
 * (plans-pg-canonical-migration-2026-06-03 D-003); plan_revisions below is the
 * audit trail, surfaced by RevisionsPanel. */

export type PlanRevisionAuthorKind = 'agent' | 'human';
export type PlanRevisionSessionKind =
  | 'plan_run'
  | 'operator_chat'
  | 'agent_chat'
  | 'git_backfill';

export interface PlanRevision {
  /** Global plan_revisions id — the address the P-008 transcript verb
   *  takes. */
  id: number;
  /** 1-based per-plan revision number. */
  seq: number;
  contentHash: string;
  rationale: string | null;
  authorKind: PlanRevisionAuthorKind;
  authorId: string;
  sessionId: string | null;
  sessionKind: PlanRevisionSessionKind | null;
  createdAt: number;
  diffStat: { added: number; removed: number };
}

export function fetchPlanRevisions(slug: string) {
  return getJson<{ revisions: PlanRevision[] }>('revisions', { slug });
}

/** The Revisions panel hook (P-017) — newest-first revision chain. An
 *  empty chain (no recorded revisions) is `data: []` not an error. */
export function usePlanRevisions(slug: string | null): AsyncResult<PlanRevision[]> {
  const args = useMemo<Record<string, unknown>>(() => (slug ? { slug } : {}), [slug]);
  return useSyncRows<PlanRevision>('plans.revisions', args, !!slug);
}

/** plans:revision-diff result envelope (P-018). `error: 'unknown_revision'`
 *  on a bad id; `error: 'revision_diff_unavailable'` on a DB failure. */
export interface PlanRevisionDiffResult {
  diff: string;
  slug: string;
  seq: number;
  /** null when seq === 1 (creation diff against empty). */
  priorSeq: number | null;
}

export async function fetchPlanRevisionDiff(revisionId: number): Promise<PlanRevisionDiffResult> {
  return getJson<PlanRevisionDiffResult>('revision-diff', {
    revisionId: String(revisionId),
  });
}

/* ── plan_run_turns (plan-agent-launch P-019) ──────────────────────── */

export type PlanRevisionTranscriptTurnRole = 'user' | 'assistant';

export interface PlanRevisionTranscriptTurn {
  seq: number;
  role: PlanRevisionTranscriptTurnRole;
  content: string;
  createdAt: number;
}

/** `plans:revision-transcript` success result. `available:false` means
 *  the revision has no drill-downable conversation: a direct edit, a
 *  git backfill, or a session kind v1 doesn't read (D-020). */
export type PlanRevisionTranscriptResult =
  | {
      available: true;
      revisionId: number;
      planSlug: string;
      seq: number;
      query: string | null;
      turns: PlanRevisionTranscriptTurn[];
      nextCursor: number | null;
    }
  | {
      available: false;
      revisionId: number;
      planSlug: string;
      seq: number;
      reason: 'no_session' | 'git_backfill' | 'session_kind_unsupported';
      turns: [];
    };

export interface FetchPlanRevisionTranscriptArgs {
  revisionId: number;
  query?: string;
  cursor?: number;
  limit?: number;
}

export function fetchPlanRevisionTranscript(
  args: FetchPlanRevisionTranscriptArgs,
): Promise<PlanRevisionTranscriptResult> {
  return getJson<PlanRevisionTranscriptResult>('revision-transcript', {
    revisionId: String(args.revisionId),
    query: args.query,
    cursor: args.cursor !== undefined ? String(args.cursor) : undefined,
    limit: args.limit !== undefined ? String(args.limit) : undefined,
  });
}

/* ── plan_runs (plan-agent-launch P-015 / P-021) ───────────────────── */

export type PlanRunStatus =
  | 'running'
  | 'idle'
  | 'archived'
  | 'done'
  | 'failed';

export interface PlanRun {
  id: number;
  planSlug: string;
  planContentHash: string;
  sessionId: string;
  note: string | null;
  launchedBy: string;
  launchedAt: number;
  status: PlanRunStatus;
  title: string | null;
  updatedAt: number;
  turnCount: number;
}

export function fetchPlanRuns(slug: string) {
  return getJson<{ runs: PlanRun[] }>('runs', { slug });
}

/** Agents-tab past-runs hook (P-021). Empty list when the plan has
 *  never been launched. */
export function usePlanRuns(slug: string | null): AsyncResult<PlanRun[]> {
  const args = useMemo<Record<string, unknown>>(() => (slug ? { slug } : {}), [slug]);
  return useSyncRows<PlanRun>('plans.runs', args, !!slug);
}

/* ── plans:launch (P-022) ──────────────────────────────────────────── */

export interface LaunchPlanAgentArgs {
  slug: string;
  /** Optional free-text instruction. Absent → default kickoff. */
  note?: string;
}

/** Success envelope from `plans:launch` in background mode (the admin
 *  UI path). The agent turn continues running after this resolves;
 *  status flips from 'running' → 'idle'/'failed' asynchronously, and
 *  the UI polls `plans:runs` to observe the change. */
export interface LaunchPlanAgentResult {
  runId: number;
  sessionId: string;
  status: 'running';
  planSlug: string;
  mode: 'background';
}

export function launchPlanAgent(args: LaunchPlanAgentArgs) {
  return postJson<WriteResult<LaunchPlanAgentResult>>('launch', {
    slug: args.slug,
    note: args.note,
    // Admin route always runs the turn in background — the POST
    // can't stream, and a long block would hang the UI.
    await: false,
  });
}

/* ── plans:resume (P-024) ──────────────────────────────────────────── */

export interface ResumePlanAgentArgs {
  runId: number;
  message: string;
}

export interface ResumePlanAgentResult {
  runId: number;
  sessionId: string;
  status: 'running';
  planSlug: string;
  mode: 'background';
}

export function resumePlanAgent(args: ResumePlanAgentArgs) {
  return postJson<WriteResult<ResumePlanAgentResult>>('resume', {
    runId: args.runId,
    message: args.message,
    await: false,
  });
}

/* ── plans:run-transcript (P-023) ──────────────────────────────────── */

export type PlanRunTranscriptTurnRole = 'user' | 'assistant';

export interface PlanRunTranscriptTurn {
  seq: number;
  role: PlanRunTranscriptTurnRole;
  content: string;
  createdAt: number;
}

export interface PlanRunTranscriptResult {
  runId: number;
  planSlug: string;
  sessionId: string;
  status: PlanRunStatus;
  planContentHash: string;
  turns: PlanRunTranscriptTurn[];
  nextCursor: number | null;
  query: string | null;
}

export interface FetchPlanRunTranscriptArgs {
  runId: number;
  query?: string;
  cursor?: number;
  limit?: number;
}

export function fetchPlanRunTranscript(
  args: FetchPlanRunTranscriptArgs,
): Promise<PlanRunTranscriptResult> {
  return getJson<PlanRunTranscriptResult>('run-transcript', {
    runId: String(args.runId),
    query: args.query,
    cursor: args.cursor !== undefined ? String(args.cursor) : undefined,
    limit: args.limit !== undefined ? String(args.limit) : undefined,
  });
}

/* ── Open agent console for a run (P-023) ──────────────────────────── */

/** Spawn a native terminal that resumes the run's agent CLI session in
 *  place (`<bin> -r <sessionId>`). Same /api/agent-mcp/console/launch
 *  endpoint as the global "+" button — with `resumeSessionId`,
 *  `planSlug` (so the terminal gets its per-plan background color),
 *  and `label` (so the window title is the plan title, not the bare
 *  session id) filled in. Returns the server's status payload (or
 *  throws on a transport error). */
export async function launchPlanRunConsole(args: {
  sessionId: string;
  planSlug: string | null;
  label: string | null;
}): Promise<unknown> {
  const r = await fetch('/api/agent-mcp/console/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      slug: null,
      mode: 'shell',
      resumeSessionId: args.sessionId,
      planSlug: args.planSlug,
      label: args.label,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`console launch → ${r.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`console launch → non-JSON: ${text.slice(0, 200)}`);
  }
}

/* ── Lint hook (P-206) ─────────────────────────────────────────────── */

/**
 * Lint one plan; refetch on `tick` change (caller bumps after writes)
 * + on window focus. Returns the parsed PlanLintReport — null while
 * loading or when the plan is exempt/missing.
 */
export function usePlanLint(slug: string | null, tick: number): AsyncResult<PlanLintReport | null> {
  const [data, setData] = useState<PlanLintReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localTick, setLocalTick] = useState(0);
  const refresh = () => setLocalTick((t) => t + 1);

  useEffect(() => {
    if (!slug) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const res = await lintPlan({ slug });
        if (cancelled) return;
        // plans:lint returns `{ reports: [...] }` on success and
        // `{ error: '<code>', slug }` on isError — the unwrap drops the
        // MCP envelope so both shapes show up here. Defend against the
        // error shape rather than destructuring `reports` blind.
        const reports = (res as { reports?: PlanLintReport[] }).reports;
        if (Array.isArray(reports)) {
          setData(reports[0] ?? null);
          setError(null);
        } else {
          const err = (res as { error?: string }).error;
          setData(null);
          setError(err ?? 'unexpected lint response');
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    const onFocus = () => run();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, tick, localTick]);

  return { data, loading, error, refresh };
}

/* ── Mutation hook ─────────────────────────────────────────────────── */

export interface MutationState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
}

/**
 * One-shot mutation hook for assisted writes.
 *
 *   const status = useMutation(setItemStatus);
 *   await status.run({ slug, itemId, status: 'done' });
 *
 * Returns a tuple of (run, state). `run` resolves with the verb's
 * result (`{ ok: true, ... } | { ok: false, code, ... }`) and never
 * throws on a domain failure — only on transport errors.
 */
export function useMutation<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
): [(args: TArgs) => Promise<TResult>, MutationState<TResult>] {
  const [state, setState] = useState<MutationState<TResult>>({
    loading: false,
    error: null,
    data: null,
  });
  const run = async (args: TArgs): Promise<TResult> => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await fn(args);
      setState({ loading: false, error: null, data });
      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ loading: false, error: msg, data: null });
      throw e;
    }
  };
  return [run, state];
}
