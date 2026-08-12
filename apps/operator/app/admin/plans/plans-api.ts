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

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { ReportBlock } from '@papercusp/chat-protocol';
import type { AuthorIdentity } from '../../_components/AuthorBadge';

export type { AuthorIdentity };

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

/**
 * A row of the `plans.list` sync feed.
 *
 * ⚠ EVERY OPTIONAL FIELD BELOW IS `?: T`, NEVER `T | null` — deliberately, and
 * the same contract `AttentionItem` carries (WI-7045 / no-http-anywhere-2026-07-28
 * D-025). The server's UI projection omits null-valued keys from this feed
 * (`ui-read-projection.ts` `projectList` — 125,553 B of a live 823,983 B payload),
 * so an absent value arrives as `undefined`, not `null`. Declaring these `T | null`
 * would keep a stale `row.priority === null` typechecking while being ALWAYS FALSE
 * at runtime — a silent, invisible-to-tsc bug. As `?: T` the same line is a TS2367
 * no-overlap error. Read them with `??` / `?.` / truthiness, never `=== null`.
 */
export interface PlanListRow {
  slug: string;
  title?: string;
  status: PlanStatus;
  /** Last REAL activity on the plan — the PG `updated_at` write timestamp
   *  (ISO), guarded server-side against no-op bumps. Falls back to the
   *  authored frontmatter date on rows a stale server serializes. */
  updated?: string;
  /** Frontmatter created date — absent when the plan never set one. */
  created?: string;
  owner?: string;
  /** P-015: free-text initiative grouping label. Plans sharing a label group
   *  together via the plans-list initiative filter facet (shared-hive-
   *  collaboration). Absent when unset, or from a server predating P-015. */
  initiative?: string;
  /** B1 (P-001): resolved owner identity (handle/avatar) for the ownership badge —
   *  derived from `owner` server-side. Absent from a server predating B1 or
   *  when the attribution flag is off. */
  ownerIdentity?: AuthorIdentity;
  /** B1 (P-001): resolved last-editor identity (latest plan revision author). */
  lastEditor?: AuthorIdentity;
  archived: boolean;
  isLegacy: boolean;
  itemCounts?: Partial<Record<ItemStatus | 'unknown', number>>;
  nextAction?: string;
  /**
   * Resolved harness slug for the plan — per
   * `plans-newbutton-and-subharness-scope-2026-05-25` P-022. Always
   * present (the server resolver falls back to the workspace primary
   * when no ctx harness is provided).
   */
  harness: string;
  /** Operational start state — absent means never started. */
  startStatus?: Exclude<PlanStartStatus, null>;
  /** Cross-plan dispatch rank — lower = dispatched first. Absent = no explicit
   *  priority (uses started_at order). */
  priority?: number;
  /** Importance of the plan's hottest OPEN item (done/dropped excluded);
   *  absent when no items are open. Items without an `importance:` keyword
   *  count as 'normal'. */
  maxImportance?: Importance;
  /** 'scout' when the Scout loop routed this plan (ledger-derived server-side).
   *  Absent otherwise, or from a server predating the field. */
  origin?: 'scout';
  /** P-021 schedule glance — true when the plan has a recurrence set OR a one-shot
   *  fire time (scheduled-recurring-plans-2026-06-16). Undefined from a server
   *  predating the field. */
  scheduled?: boolean;
  /** Armed/firing (true) vs saved-but-paused/disarmed (false). */
  scheduleActive?: boolean;
  /** A recurrence set (`recurring`) vs a one-shot `scheduled_at` (`one-shot`); absent ⇒ unscheduled. */
  scheduleKind?: 'recurring' | 'one-shot';
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
  /** B1 (P-001): per-item author (the harness_plan_parts.author pubkey resolved
   *  to an identity). Null/undefined when no real per-op author has federated
   *  (single-box origin sentinels are dropped server-side). */
  lastEditedBy?: AuthorIdentity | null;
}

/**
 * The subset of {@link PlanItem} that survives the plans:items UI projection
 * (`ITEM_DROP` in operator-core agent-tools/plans/ui-read-projection.ts).
 *
 * Narrowed rather than reusing `PlanItem` because that type is SHARED with
 * `plans:get`, which is the full-fidelity detail read and passes through the
 * projection byte-identical — PlanDetail/PlanEditor/PlanKanbanView legitimately
 * read `storedStatus`/`phase`/`blockedBy`/`decisionRefs`/`lineNumber` there.
 * Declaring them here too would tell this feed's consumers a field is available
 * when the projection has already dropped it (WI-7086; same split as
 * `CodeRecipeListRow` vs `CodeRecipeRow` in WI-7085).
 */
export interface PlanListItem {
  id: string;
  effectiveStatus: ItemStatus;
  text: string;
  /** 4th axis — urgent|high|normal|low. Surfaced as a row badge + sort key. */
  importance?: Importance;
  /** ABSENT — never null — when no real per-op author has federated. The
   *  resolver omits the key entirely (plan-attribution.ts), so declaring this
   *  `?: T` rather than `T | null` turns a future `=== null` into a TS2367
   *  no-overlap error instead of a silently-always-false branch. */
  lastEditedBy?: AuthorIdentity;
}

/**
 * `plans:items` returns rows that carry the parent plan's slug — the
 * cross-plan use cases (inbox, actionable) need to know which plan
 * each item came from.
 *
 * No `archived`: the projection drops it (no consumer branched on it).
 */
export interface PlanItemRow {
  plan: string;
  item: PlanListItem;
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
  | 'discuss'
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

/**
 * ⚠ THE OPTIONAL (`?:`) FIELDS BELOW ARE OPTIONAL ON PURPOSE, AND THE ABSENCE OF
 * `| null` ON THEM IS LOAD-BEARING (no-http-anywhere-2026-07-28 D-025 / WI-7039).
 *
 * The `plans.attention` LIST feed omits null-valued keys in the resolver
 * projection (`ui-read-projection.ts` `omitNullValues`) — 14.6% of a 1,062 KB
 * payload. So on the wire these arrive ABSENT, i.e. `undefined`, never `null`.
 * Declaring them `T | null` would keep `item.triagedBy === null` typechecking
 * while being always-false at runtime; declaring them `?: T` makes that
 * comparison a TS2367 no-overlap error, which is the whole point.
 *
 * Read them with truthiness or `??`. Do NOT re-add `| null` to make a
 * comparison compile — fix the comparison.
 */
export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  source: string;
  harnessSlug?: string;
  planSlug?: string;
  itemRef?: string;
  title: string;
  body: string;
  status: string;
  importance: Importance;
  /** Which inbox tier this belongs to (D-002/D-006). */
  tier: AttentionTier;
  needsHuman: boolean;
  /** The owning agent (the coord record's `from`), drives "Message owner". */
  ownerAgentId?: string;
  ownerLabel?: string;
  /** Operator-triage overlay (D-006). */
  triageState: TriageState;
  triageNote?: string;
  triagedBy?: string;
  triagedAt?: string;
  /** DETAIL-tier (WI-6551): the `plans.attention` LIST feed drops this — see
   *  `ATTENTION_ITEM_DROP` in operator-core's ui-read-projection.ts — and it is
   *  re-supplied by the `plans.attentionItem` detail fetch. It is therefore
   *  ABSENT between first paint and hydration, so it MUST stay optional: when it
   *  was declared `AttentionAction[]`, the type asserted a guarantee the wire
   *  format does not provide, tsc stayed silent, and `attentionItemToCardSpec`
   *  iterated `undefined` and took down the whole HUD tab. Guard every read
   *  (`item.actions ?? []`) rather than trusting the declaration. */
  actions?: AttentionAction[];
  ref: { kind: AttentionKind } & Record<string, unknown>;
  /** Structured report payload — the shared ReportBlock the detail pane
   *  renders natively via ReportBlockCard. Set by `operator-report` items
   *  (report-cards-inbox-reconciliation-2026-06-05 D-001/D-003) and by a
   *  report-carrying `coord-message` (an agent/fleet-leader status card sent
   *  via coord:send `report` — agent-report-cards-2026-07-17 P-002). */
  report?: ReportBlock;
  /** The autonomy category this item's disposition belongs to (absent for an
   *  ungoverned signal). Drives the category badge. */
  category?: string;
  /** A1 authorizer-split (queue-authorization-redesign P-002): WHO must sign off
   *  on this Decision + WHY it's gated. Set for `needsHuman` items only. */
  authorizer?: 'you' | 'queen-eligible';
  whyGated?: 'protected' | 'owner-only' | 'unarmed' | 'above-ceiling';
  /** ISO timestamp of when the underlying event occurred (message/escalation
   *  sent, work-item updated, gate opened, report turn, …). Drives the Inbox
   *  card's date + recency ordering (inbox-pane-active-scope-dates-filters-2026-07-19).
   *  Absent when a source has no natural per-item timestamp. */
  occurredAt?: string;
}

export interface AttentionGroup {
  key: string;
  kind: 'plan' | 'alerts';
  /** Optional, not nullable — the LIST feed omits null keys (see the
   *  {@link AttentionItem} header). Absent on the synthetic Alerts buckets. */
  planSlug?: string;
  /** Optional, not nullable — absent on a cross-harness group. */
  harnessSlug?: string;
  title: string;
  items: AttentionItem[];
  maxImportance: Importance;
}

/**
 * Live-query deltas can briefly expose a sparse row while a keyed attention
 * group is being replaced. The Queue reads `.kind` synchronously, so one
 * undefined/null item used to take down the entire Create tab. Normalize at
 * the shared sync hook — the same boundary every Create/Plans consumer uses —
 * instead of teaching each panel to survive malformed cache snapshots.
 */
export function normalizeAttentionGroups(rows: readonly unknown[]): AttentionGroup[] {
  const groups: AttentionGroup[] = [];
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const group = value as Partial<AttentionGroup> & { items?: unknown };
    if (typeof group.key !== 'string' || !Array.isArray(group.items)) continue;
    const items = group.items.filter(
      (item): item is AttentionItem => !!item && typeof item === 'object' && typeof (item as { kind?: unknown }).kind === 'string',
    );
    groups.push({ ...group, items } as AttentionGroup);
  }
  return groups;
}

/**
 * Flatten `groups[].items` into one deduped-by-`id` list — the shared,
 * correct way for a UI consumer to derive "every attention item" from the
 * `plans.attention` feed.
 *
 * A non-plan-scoped item (owner-wall, loop-carry-note, an alert not tied to
 * one plan) legitimately appears in MULTIPLE groups server-side, so a bare
 * `groups.flatMap(g => g.items)` emits it once per group — duplicate React
 * keys, rows rendered 2-5x, and any derived count disagreeing with the
 * visible list (WI-5337, fixed in `useInboxAttention`). That fix lived only
 * in the Inbox pane's hook; `AdvOverviewTab`'s Overview tiles flatten the
 * SAME feed independently and re-introduced the identical bug
 * (EI-19373923898562595 — reproduced live: 6 duplicate-key console errors on
 * `?tab=overview`, item `owner-wall:loop-carry-note:<su-id>`). Centralizing
 * the dedupe here means every current AND future consumer of `usePlanAttention`
 * gets it for free instead of re-deriving it (and re-forgetting it).
 */
export function flattenAttentionItems(groups: readonly AttentionGroup[]): AttentionItem[] {
  const seen = new Set<string>();
  const out: AttentionItem[] = [];
  for (const g of groups) {
    for (const it of g.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
  }
  return out;
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
  /** Resolved hive/home harness that owns this plan row. */
  harness?: string | null;
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
  /** B1 (P-001): resolved plan owner + last-editor identities for the detail
   *  ownership badges. Undefined when the attribution flag is off. */
  ownerIdentity?: AuthorIdentity | null;
  lastEditor?: AuthorIdentity | null;
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

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return !!value && typeof value === 'object' && 'aborted' in value;
}

export function fetchPlan(
  slug: string,
  harnessSlugOrSignal?: string | null | AbortSignal,
  signal?: AbortSignal,
) {
  const harnessSlug = typeof harnessSlugOrSignal === 'string' ? harnessSlugOrSignal : null;
  const actualSignal = isAbortSignalLike(harnessSlugOrSignal) ? harnessSlugOrSignal : signal;
  // mode:'full' is REQUIRED here. `plans:get` defaults to mode:'sections',
  // which returns frontmatter + items + a section INDEX but NOT the prose/raw
  // markdown body (the default protects agent payloads from a 90KB blob —
  // plans-pg-canonical-migration-2026-06-03). The UI consumers of usePlan
  // (PlanDetail's Vditor editor, PlanItemPreview) and rejectDraftPlan all read
  // `data.raw`/`data.prose` to render/round-trip the whole plan, so without
  // mode:'full' the editor renders BLANK. These are user-driven, one-plan-at-
  // a-time fetches, so the full body is the right payload.
  return getJson<PlanGetResult>(
    'get',
    { slug, mode: 'full', ...(harnessSlug ? { harness: harnessSlug } : {}) },
    actualSignal,
  );
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

/** D-007 (owner-inbox-single-pane-2026-07-17 P-006): deliver + wake an inbox
 *  reply to its LIVE asker (coord:presence). Routes through the dedicated
 *  `/api/admin/coord-inbox-reply` endpoint — NOT the generic coord:send proxy
 *  — because delivery stamps the owner-authoritative `coord-inject:owner`
 *  turn-provenance origin (D-006), which must never be reachable via the
 *  agent-callable coord:send tool. Returns `live:false` when the asker isn't
 *  live; the caller falls back to the Discuss (Papercup) path. */
export function deliverInboxReply(args: { askerId: string; text: string; summary?: string; planSlug?: string }) {
  return postFullUrl<{ ok: boolean; live: boolean; delivered: boolean; woken: number; msgId?: string; error?: string }>(
    '/api/admin/coord-inbox-reply',
    args,
  );
}

/** Like `postJson`/`postCoord` but against an absolute path (not the `/api/admin/plans`
 *  or `/api/admin/coord` base) — for the small set of admin write routes that
 *  deliberately live outside those two proxies (e.g. coord-inbox-reply, D-006). */
async function postFullUrl<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${url} → ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
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

/* ── Cross-user handoff / @-mention assign (shared-hive-collaboration P-008/P-016) ──
 *  The "assign this plan/item to @user" surface. The picker roster (P-016) unions
 *  LIVE coordination sessions (present — deliver-and-wake now) with OFFLINE admitted
 *  hive members (parked until they return). The assign action is a coord:send (via
 *  the /api/admin/coord proxy, sender = the admin UI owner): a present member is
 *  addressed by a live ownerId; an offline member by `@user:gh:<id>`, which parks
 *  in slot_parked_messages and is delivered when that member next reads their inbox. */

/**
 * A pickable @-assign target (shared-hive-collaboration P-016): either a LIVE
 * coordination session or an OFFLINE admitted hive member. The server
 * (dev.assignableMembers) precomputes `assignAddress` — what to pass to
 * assignToUser's `to` — so the UI never constructs the coord `@user:` selector
 * itself: a present member is a plain ownerId; an offline member is `@user:gh:<id>`.
 */
export interface AssignableMember {
  /** The coord:send `to` address: a live ownerId, or `@user:gh:<id>` (offline). */
  assignAddress: string;
  /** Stable id for React keys + the per-user color dot. */
  key: string;
  label: string;
  /** True for a live session (deliver-and-wake), false for an offline member (park). */
  present: boolean;
  intent: string | null;
  userId: string | null;
  githubUsername: string | null;
}

/** The @-assign picker roster — live sessions + offline workspace members
 *  (dev.assignableMembers). Reuses the sync layer (SSE-pushed; a presence flip
 *  or a new admission refreshes it via the table→query map). */
export function useAssignableMembers(): AsyncResult<AssignableMember[]> {
  return useSyncRows<AssignableMember>('dev.assignableMembers', EMPTY_ARGS);
}

export interface AssignArgs {
  /** The coord:send `to` address(es): a live ownerId, or an offline member's
   *  `@user:gh:<id>` selector — i.e. an AssignableMember's `assignAddress`. */
  to: string[];
  planSlug: string;
  /** Plan-item id (e.g. 'P-005') when assigning a single item; omit for the whole plan. */
  itemRef?: string | null;
  /** Optional free-text note from the assigner. */
  note?: string | null;
  /** Deliver-and-wake (default true) — fires the assignee's inbox-wake. */
  wake?: boolean;
}

export interface AssignResult {
  ok?: boolean;
  msg_id?: string;
  error?: string;
  wake?: { mode?: string; woken?: number; recipient_absent?: boolean };
}

/** Assign a plan or plan-item to a hive member: a coord:send (wake:'optimistic')
 *  that lands durably in their inbox AND best-effort re-invokes them now.
 *  Optimistic (not 'required') because the assignee may be asleep and the
 *  assignment still lands + the Queen survey re-dispatches — a miss is silent,
 *  not a loud recipient_absent (directed-wake-honesty D-002; shared-hive-collab P-008). */
export function assignToUser(args: AssignArgs): Promise<AssignResult> {
  const target = args.itemRef
    ? `item ${args.itemRef} (plan ${args.planSlug})`
    : `plan ${args.planSlug}`;
  const summary = `📋 Assigned to you: ${target}`;
  const body =
    `You've been assigned ${target} via the plans UI.` +
    (args.note ? `\n\nNote: ${args.note}` : '');
  return postCoord<AssignResult>('send', {
    to: args.to,
    summary,
    body,
    // default 'optimistic' (durable backstop = the Queen survey); explicit wake:false ⇒ no wake.
    wake: args.wake === false ? undefined : 'optimistic',
    plan_slug: args.planSlug,
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

/**
 * The `plans:list` archived/legacy filter, as a pure client-side predicate over
 * rows the server already stamped with `archived` + `isLegacy`
 * (slim-plans-attention-sync-payload-2026-07-26 P-001).
 *
 * This MIRRORS the server's own filter, so the two must not drift — see
 * plans-list-superset-filter.test.ts, which pins both defaults against the
 * literal expressions in `agent-tools/plans/list.ts`:
 *   `includeArchived = args.includeArchived === true`   → default FALSE
 *   `includeLegacy   = args.includeLegacy !== false`    → default TRUE
 * (the asymmetry is easy to get backwards, which is the whole reason this is a
 * named + tested function rather than an inline `.filter()`).
 */
export function filterPlanListRows(
  rows: readonly PlanListRow[] | undefined,
  opts: { includeArchived: boolean; includeLegacy: boolean },
): PlanListRow[] {
  if (!rows) return [];
  if (opts.includeArchived && opts.includeLegacy) return rows as PlanListRow[];
  return rows.filter(
    (p) => (opts.includeArchived || !p.archived) && (opts.includeLegacy || !p.isLegacy),
  );
}

/**
 * The plans list.
 *
 * ONE sync cache entry per (status, harness_slugs) scope, regardless of the
 * caller's archived/legacy preference: this always fetches the SUPERSET
 * (`includeArchived: true, includeLegacy: true`) and narrows client-side via
 * {@link filterPlanListRows}.
 *
 * Why (P-001, measured on live :3070 2026-07-26): eight call sites asked for
 * three different arg shapes — `{}` (PlansPane), `{true,true}` (AdvPlansTabs,
 * AdvSessionsClient) and `{false,false}` (AdvOverviewTab, MugTab) — which the
 * sync layer keys separately, so a cold wave fetched ~763KB THREE times for
 * what is one 895-row dataset differing by 15 rows. The narrowing axis is two
 * booleans already present on every row, so collapsing it costs a `.filter()`
 * and saves ~1.5MB per cold wave.
 *
 * `status` and `harness_slugs` stay SERVER-side deliberately: legacy plans
 * report status `draft` (a server-side rule this predicate does not know), and
 * a harness scope is not reproducible from row fields — the same trap that
 * killed the equivalent collapse for `plans.attention` (see the plan's D-001,
 * where a client-side `harnessSlug` filter would have silently dropped ~677
 * items). Only collapse an axis you can prove is a pure row predicate.
 */
export function usePlanList(params?: {
  status?: PlanStatus;
  includeArchived?: boolean;
  includeLegacy?: boolean;
  /** P-029: fan out across multiple harnesses. Pass undefined to use
   *  the ctx-resolved single harness. */
  harness_slugs?: readonly string[];
  /**
   * Gate the subscription (default true). Exposed so a call site that only
   * needs plans while its tab is open does NOT have to hand-roll a raw
   * `useSyncQuery('plans.list')` to get an `enabled` — which is how a second,
   * near-identical 800 KB key got minted (no-http-anywhere-2026-07-28 P-026).
   * `useSyncResource` already supported it; only this signature did not.
   */
  enabled?: boolean;
}): AsyncResult<{ plans: PlanListRow[] }> {
  // Stable join so a same-content array doesn't churn the query key.
  const harnessSlugsKey = params?.harness_slugs?.slice().sort().join('|') ?? '';
  const args = useMemo<Record<string, unknown>>(
    () => ({
      ...(params?.status ? { status: params.status } : {}),
      // The superset on the archived/legacy axis — narrowed client-side below.
      includeArchived: true,
      includeLegacy: true,
      ...(params?.harness_slugs ? { harness_slugs: [...params.harness_slugs] } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params?.status, harnessSlugsKey],
  );
  const r = useSyncResource<PlanListRow, 'plans'>('plans.list', args, 'plans', params?.enabled ?? true);
  // Mirror the SERVER defaults exactly: archived off unless asked, legacy on
  // unless refused (see filterPlanListRows).
  const includeArchived = params?.includeArchived === true;
  const includeLegacy = params?.includeLegacy !== false;
  const plans = useMemo(
    () => filterPlanListRows(r.data?.plans, { includeArchived, includeLegacy }),
    [r.data?.plans, includeArchived, includeLegacy],
  );
  return { ...r, data: { plans } };
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

/**
 * Read one plan's full body (mode:'full' — frontmatter + items + raw markdown).
 *
 * Two consumption modes, chosen by `opts.live`:
 *
 *  - **`live: false` (default) — guarded one-shot** (`useAsyncJson`): fetch on
 *    mount/slug-change plus an explicit `refresh()`, and exposes `setData` for
 *    optimistic in-place patches. This is what **PlanDetail's Vditor editor**
 *    uses: a LIVE re-fire mid-edit would clobber the user's in-progress draft
 *    (data-sync-push-completion P-011 — "do NOT make PlanDetail's editor live").
 *    The editor decides when to reload (its own `onChanged()` / 10s interval),
 *    never the sync layer.
 *
 *  - **`live: true` — shared live sync query** (`useSyncQuery`,
 *    `queryName:'plans.get'`): subscribes to the shared `['sync','plans.get',args]`
 *    cache; any `plans:*` write pushes a fresh row over SSE
 *    (`harness_plans` is bridged). Used by the **read-only** consumer
 *    PlanItemPreview, which only reads `{ data, loading, error }` and never
 *    edits — so a live re-fire is safe and desirable. No `setData` (the live
 *    cache is server-authoritative); `refresh()` maps to `invalidate()`.
 *
 * The `plans.get` resolver returns a single-element row array `[PlanGetResult]`
 * (the SAME `callPlansRead('get', { mode:'full' })` payload the REST `fetchPlan`
 * hits, plus best-effort attribution enrichment), so the consumer renders
 * identically off `data` whichever mode is in force.
 */
export function usePlan(
  slug: string | null,
  opts?: { live?: boolean; harnessSlug?: string | null },
): AsyncResult<PlanGetResult | null> {
  const live = opts?.live ?? false;
  const harnessSlug = opts?.harnessSlug ?? null;

  // Live read-only path (PlanItemPreview). Hooks must run unconditionally, so
  // both hooks are always called; `enabled` gates which one actually fetches.
  const liveArgs = useMemo<Record<string, unknown>>(
    () => (slug ? { slug, mode: 'full', ...(harnessSlug ? { harness: harnessSlug } : {}) } : {}),
    [slug, harnessSlug],
  );
  const liveQuery = useSyncQuery<PlanGetResult>({
    queryName: 'plans.get',
    args: liveArgs,
    enabled: live && !!slug,
  });

  // Guarded one-shot path (PlanDetail editor). Skip the fetch entirely when
  // the live path is in force so we don't double-request the same plan.
  const oneShot = useAsyncJson<PlanGetResult | null>(
    (signal) => (!live && slug ? fetchPlan(slug, harnessSlug, signal) : Promise.resolve(null)),
    [slug, live, harnessSlug],
  );

  if (live) {
    return {
      data: slug ? (liveQuery.data?.[0] ?? null) : null,
      loading: liveQuery.loading,
      error: liveQuery.error ? liveQuery.error.message : null,
      refresh: () => liveQuery.invalidate(),
    };
  }
  return oneShot;
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
  const raw = useSyncResource<unknown, 'groups'>('plans.attention', args, 'groups', enabled);
  const groups = useMemo(
    () => normalizeAttentionGroups(raw.data?.groups ?? []),
    [raw.data?.groups],
  );
  return {
    ...raw,
    data: { groups },
  };
}

/** One attention item projected to just the fields a curator-card `ref`
 *  resolves against — the wire shape of `plans.attentionRefs`. Structurally
 *  the client resolver's `RefDestinationItem` (curator-card-drill-in.ts);
 *  `attention-refs-parity.test.ts` fails if the two drift apart. */
export interface AttentionRefRow {
  id: string;
  itemRef?: string;
  planSlug?: string;
  ownerAgentId?: string;
}

/**
 * The DRILL-IN half of the attention feed (no-http-anywhere-2026-07-28 D-031).
 *
 * Use this — never {@link usePlanAttention} — when all you do with the feed is
 * RESOLVE a ref (`resolveDrillInTarget` / `resolveRefDestination`). Those read
 * four fields per item; the full feed measured 1,461 KB on :3055 (891 KB on
 * :3270) and the chat sidebar that needs it is mounted by ChromeShell on every
 * non-chromeless route, so the projection is the difference between paying that
 * on every screen and not.
 *
 * A separate query name, NOT a narrowing of `usePlanAttention`'s args: args
 * narrowing is pushed down into ~10 sources server-side and silently drops rows
 * (D-029, and D-001 of slim-plans-attention where it cost ~677 items). This
 * changes the ROW shape only — every item the fat feed would have contained is
 * still here, so client-side matching is unaffected.
 *
 * Unscoped by design, like the counts and detail siblings: a curator card can
 * name something in any harness.
 */
export function useAttentionRefs(enabled = true): {
  items: AttentionRefRow[];
  loading: boolean;
} {
  const q = useSyncQuery<AttentionRefRow>({
    queryName: 'plans.attentionRefs',
    args: EMPTY_ARGS,
    enabled,
  });
  // A disabled query keeps whatever it last held; the caller's contract is
  // "the rows currently resolvable", so an empty list is the honest answer
  // both before the first load and while gated off.
  const items = useMemo(() => (Array.isArray(q.data) ? q.data : []), [q.data]);
  return { items, loading: q.loading };
}

/**
 * The DETAIL half of the attention list/detail split
 * (slim-plans-attention-sync-payload-2026-07-26 P-004/P-005).
 *
 * The `plans.attention` list feed is slimmed at the sync boundary — each item's
 * `body` is clipped to a preview and `actions` is dropped — because it was the
 * fattest UI read at 1490KB. This fetches the ONE selected item back at full
 * fidelity. Cheap: the resolver rides the plans:attention tool's own warm read
 * cache, which the list feed just populated.
 *
 * Consumers should not call this directly — {@link useHydratedAttentionItem}
 * merges the result over the list row, which is what `OtherDetail` uses.
 */
export function usePlanAttentionItem(id: string | null): AsyncResult<AttentionItem | null> {
  const args = useMemo<Record<string, unknown>>(() => (id ? { id } : {}), [id]);
  const q = useSyncQuery<AttentionItem>({
    queryName: 'plans.attentionItem',
    args,
    enabled: !!id,
  });
  return {
    data: id ? (q.data?.[0] ?? null) : null,
    loading: q.loading,
    error: q.error ? q.error.message : null,
    refresh: () => q.invalidate(),
  };
}

/**
 * A list-feed attention row with its detail-tier fields filled back in.
 *
 * Returns the LIST row immediately (so the detail pane paints its title, tier,
 * badges and layout with no spinner) and merges the full row over it when it
 * arrives — the clipped `body` becomes the full body and `actions` reappears.
 * `hydrated` is false until then, which is what gates rendering the action card:
 * a card built from a row with no `actions` would render as a question with no
 * buttons, which reads as "this item has no actions" rather than "still loading".
 *
 * A failed detail fetch degrades to the list row rather than blanking the pane —
 * the preview body and every non-action affordance still work.
 */
export function useHydratedAttentionItem(item: AttentionItem | null): {
  item: AttentionItem | null;
  hydrated: boolean;
} {
  const detail = usePlanAttentionItem(item?.id ?? null);
  const full = detail.data;
  return useMemo(() => {
    if (!item) return { item: null, hydrated: false };
    // Only accept a detail row for the item we actually asked about — an
    // in-flight selection change can otherwise merge the previous item's body.
    if (!full || full.id !== item.id) return { item, hydrated: false };
    return { item: { ...item, ...full }, hydrated: true };
  }, [item, full]);
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

/** Render one failure (flat result OR a bulk `results[i]`) as a human string. */
function describeWriteFailure(o: Record<string, unknown>): string {
  const error = typeof o.error === 'string' ? o.error : null;
  if (!error) return 'unexpected response shape';
  // The lock-conflict path carries the holder's identity — surface it inline so
  // the user knows who/what to wait for.
  if (error === 'busy' && Array.isArray(o.busy) && o.busy.length > 0) {
    const b = (o.busy[0] ?? {}) as { owner_label?: string; intent?: string };
    const who = b.owner_label ?? 'another agent';
    return b.intent ? `busy: held by ${who} (${b.intent})` : `busy: held by ${who}`;
  }
  return error;
}

/**
 * Did a plans write fail, and if so why? Returns null on success.
 *
 * ⚠ THE BULK ENVELOPE IS CHECKED FIRST, AND THAT ORDER IS THE WHOLE POINT (WI-6941).
 * Most plans:* tools are bulk, and `runBulk` hardcodes the envelope's **top-level
 * `ok` to `true`** — per-item success lives in `results[i].ok`. The admin route
 * unwraps that envelope only for `get`, so a wrapped failure reaches here looking
 * exactly like a success. Reading `o.ok` first (as this function did until
 * 2026-08-02) therefore reported EVERY failed bulk write as succeeded: a
 * `claim_conflict` on an item a live peer holds rendered as a completed status flip,
 * and the popover closed. Verified live on :3170:
 *
 *   set-status { item: 'P-999' }
 *     → { ok: true, results: [{ ok: false, error: 'item_not_found' }], counts: { failed: 1 } }
 *
 * If you are tempted to hoist the `ok` check back to the top for readability: that is
 * the bug.
 */
export function writeError(r: WriteResult<unknown> | unknown): string | null {
  if (!r || typeof r !== 'object') return 'unexpected response shape';
  const o = r as Record<string, unknown>;

  if (Array.isArray(o.results)) {
    const failed = o.results.find(
      (x) => x && typeof x === 'object' && (x as { ok?: unknown }).ok === false,
    );
    if (failed) return describeWriteFailure(failed as Record<string, unknown>);
    // An empty result set means nothing was written — reporting that as success is
    // the same silent-failure shape this function exists to catch.
    if (o.results.length === 0) return 'write affected nothing';
    return null;
  }

  if (o.ok === true) return null;
  return describeWriteFailure(o);
}

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

/**
 * Archive a plan (or restore it) — owner-plans-single-pane P-008 / EI-15304.
 *
 * Flips the PG-canonical `harness_plans.archived` flag via `plans:set-archived`.
 * Archived plans drop out of every default plan list (the readers filter on the
 * column) but stay readable via `includeArchived`, so this is reversible —
 * pass `archived: false` to restore. The write invalidates `plans.list` through
 * the harness_plans trigger, so the Plans face refreshes on its own.
 */
export function setPlanArchived(args: { slug: string; archived: boolean; harness?: string }) {
  return postJson<WriteResult<{ slug: string; archived: boolean }>>(
    'set-archived',
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
  const plan = await fetchPlan(slug, harnessSlug);
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
    ...(harnessSlug && { harness: harnessSlug, harness_slug: harnessSlug }),
  } as SetContentArgs & { harness?: string; harness_slug?: string });
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

/* ── Plan inputs (plan-structured-inputs-2026-08-01 P-013) ─────────── */

/**
 * A start door's refusal when a parameterized plan is missing its arguments.
 *
 * ⚠ This arrives as a **200 with an `ok: false` body**, not an HTTP error: the tool
 * returns a plain result object, and the admin route's `unwrap` passes any 200
 * through verbatim. So `startPlan` RESOLVES on a refusal — a caller that only
 * try/catches will report a success that never happened, which is exactly the bug
 * P-013 fixes at the one call site. Discriminate on `error`, never on a throw.
 */
export interface PlanStartRefusal {
  ok: false;
  error: 'plan_inputs_not_ready';
  code: 'missing_required' | 'invalid_data' | 'bad_schema' | 'unknown_template' | 'schema_conflict';
  slug: string;
  /** Declared-required fields that were not supplied. */
  missing: string[];
  /** Schema-violation detail, when the failure is malformed rather than absent. */
  issues: string[];
  source: string;
  template?: string;
  /** One-line and actionable — safe to surface verbatim. */
  hint: string;
}

export interface PlanStartOk {
  slug: string;
  harnessSlug: string;
  /**
   * NULL while the OPERATIONAL axis is retired (P-047): the plan is approved and
   * its items promoted, but no op_status was written, so there is no started
   * state to report. Reporting 'started' there would be the WI-5825 "announced a
   * start that never happened" bug wearing a feature flag.
   */
  status: string | null;
  /** Present (and true) only on that retired path — see `status`. */
  opStatusRetired?: true;
}

export function isPlanStartRefusal(r: unknown): r is PlanStartRefusal {
  return (
    !!r && typeof r === 'object' && (r as { error?: unknown }).error === 'plan_inputs_not_ready'
  );
}

/**
 * The whole input contract of a plan plus the verdict a start door would give —
 * one call, because `required`/`missing`/`ready` are computed server-side by the
 * gate's own oracle. Re-deriving readiness in the client would be a second
 * implementation of a rule the client does not own.
 */
export interface PlanInputSchemaInfo {
  ok: true;
  slug: string;
  source: 'input-schema' | 'template' | 'none';
  inputSchema: JsonSchemaObject | null;
  template: string | null;
  required: string[];
  missing: string[];
  values: Record<string, unknown> | null;
  ready: boolean;
  code?: PlanStartRefusal['code'];
  issues?: string[];
  hint?: string;
  version?: number;
}

/** The (deliberately small) slice of JSON Schema the input form renders. */
export interface JsonSchemaProperty {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: { type?: string | string[]; enum?: unknown[] };
  minimum?: number;
  maximum?: number;
}

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [k: string]: unknown;
}

export type PlanInputsResult = PlanInputSchemaInfo | { ok: false; slug?: string; error: string };

/**
 * `plans:get-input-schema` is a BULK tool, so even a single-slug call comes back as
 * `{ ok, results: [row], counts }`. The admin route only unwraps that envelope for
 * `get` (see unwrapBulkGet), so every other bulk verb arrives wrapped — which reads as
 * a row whose every field is `undefined`, i.e. a panel that silently renders nothing
 * rather than an error anyone would notice. Unwrap here, and pin it in tests: this was
 * caught by probing the live route, NOT by the component tests, which mock this
 * function and would have kept passing.
 */
export function unwrapPlanInputs(body: unknown): PlanInputsResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'malformed_response' };
  const results = (body as { results?: unknown }).results;
  if (Array.isArray(results)) {
    const row = results[0];
    return row && typeof row === 'object'
      ? (row as PlanInputsResult)
      : { ok: false, error: 'not_found' };
  }
  // Not the bulk envelope — a bare { error } from a trust/validation failure.
  return body as PlanInputsResult;
}

export async function fetchPlanInputs(
  slug: string,
  harnessSlug?: string | null,
  signal?: AbortSignal,
): Promise<PlanInputsResult> {
  const body = await getJson<unknown>(
    'get-input-schema',
    { slug, ...(harnessSlug ? { harness: harnessSlug } : {}) },
    signal,
  );
  return unwrapPlanInputs(body);
}

/** Supply a plan's input values. Partial data is accepted by design (D-004) —
 *  completeness is the start gate's business, not the writer's. */
export function savePlanInputs(
  slug: string,
  data: Record<string, unknown>,
  harnessSlug?: string | null,
) {
  return postJson<WriteResult<{ slug: string; version?: number }>>('set-template-data', {
    slug,
    data,
    ...(harnessSlug ? { harness: harnessSlug, harness_slug: harnessSlug } : {}),
  });
}

export function startPlan(slug: string, harnessSlug?: string | null) {
  return postJson<PlanStartOk | PlanStartRefusal>('start', {
    slug,
    ...(harnessSlug ? { harness: harnessSlug, harness_slug: harnessSlug } : {}),
  });
}

export function pausePlan(slug: string, harnessSlug?: string | null) {
  return postJson<{ slug: string; harnessSlug: string; status?: string; notStarted?: boolean }>(
    'pause',
    { slug, ...(harnessSlug ? { harness: harnessSlug, harness_slug: harnessSlug } : {}) },
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

const PLANS_DIR_REL = 'apps/operator/docs/plans';

/** Workspace-relative lock key matching what with-plan-lock.ts uses
 *  (apps/operator/docs/plans/[archive/]<slug>.md, POSIX). */
export function planLockPath(slug: string, archived: boolean): string {
  return archived
    ? `${PLANS_DIR_REL}/archive/${slug}.md`
    : `${PLANS_DIR_REL}/${slug}.md`;
}

/**
 * The open plan's lock holder, or null. PUSH, not poll (plan
 * semantic-search-fingerprint-coverage-2026-08-03, P-025).
 *
 * This used to bare-fetch the admin locks-queue route on a 30s
 * `window.setInterval`, justified in its own comment by "D-008 (no SSE/live
 * -sync)". That premise expired when plans moved onto `@papercusp/sync`: the
 * lock writers now emit `planLock.byPath` invalidations
 * (agent-tools/locks/notify-lock-change.ts, wired at acquire AND release), so
 * the banner updates on the actual transition instead of up to 30s late.
 *
 * ⚠ THE FOCUS / VISIBILITYCHANGE RE-FETCH IS DELIBERATELY KEPT — do not delete
 * it as leftover polling. The emit is fire-and-forget by design (a sync-bus
 * fault must never fail, or delay, the lock operation that triggered it), so a
 * dropped notify has NO retry behind it. The 30s poll was self-correcting by
 * construction; push is not, and without this backstop a lost invalidation
 * strands the banner on a holder that has already gone — strictly worse than
 * what it replaced. Returning to the tab is precisely when someone is about to
 * act on what this says.
 */
export function usePlanLock(
  slug: string | null,
  archived: boolean,
): AsyncResult<ActiveLock | null> {
  const lockPath = slug ? planLockPath(slug, archived) : null;
  const args = useMemo<Record<string, unknown>>(
    () => (lockPath ? { path: lockPath } : {}),
    [lockPath],
  );
  const rows = useSyncRows<ActiveLock>('planLock.byPath', args, !!lockPath);

  // `refresh` is a fresh closure every render, so it cannot go in the deps
  // below — that would tear down and re-register both listeners on every
  // render. The ref keeps the listeners bound for the lifetime of a lockPath
  // while still firing the CURRENT invalidate.
  const refreshRef = useRef(rows.refresh);
  refreshRef.current = rows.refresh;

  useEffect(() => {
    if (!lockPath) return;
    const onFocus = () => refreshRef.current();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshRef.current();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [lockPath]);

  return {
    // The resolver returns a 0- or 1-row array (at most one holder per path).
    // `AsyncResult.data` is nullable, so this reads through it the same way
    // usePlanViewerEmail does rather than indexing a possibly-null array.
    data: rows.data?.[0] ?? null,
    loading: rows.loading,
    error: rows.error,
    refresh: rows.refresh,
  };
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
  /** Null means no transcript rows were recorded for the run. */
  turnCount: number | null;
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
