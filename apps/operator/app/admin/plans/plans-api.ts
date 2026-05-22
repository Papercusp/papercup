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

import { useEffect, useState } from 'react';

/* ── Wire types — mirror lib/agent-tools/plans/* return shapes ─────── */

export type PlanStatus = 'draft' | 'active' | 'blocked' | 'shipped' | 'superseded' | 'unknown';
export type ItemStatus = 'todo' | 'wip' | 'blocked' | 'needs-human' | 'done' | 'dropped';

export interface PlanListRow {
  slug: string;
  title: string | null;
  status: PlanStatus;
  updated: string | null;
  owner: string | null;
  archived: boolean;
  isLegacy: boolean;
  itemCounts: Partial<Record<ItemStatus | 'unknown', number>> | null;
  nextAction: string | null;
}

export interface PlanItem {
  id: string;
  storedStatus: ItemStatus;
  effectiveStatus: ItemStatus;
  text: string;
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
  /** Server-computed hash of `raw`. The baseline `expectedHash` for a
   *  `plans:set-content` compare-and-swap (D-011). Optional: the field
   *  ships with agent-plan-tracking Phase 5 — until then the UI saves
   *  without CAS protection and the verb itself is absent anyway. */
  contentHash?: string;
  filename?: string;
  error?: string;
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
  params?: Record<string, string | boolean | undefined>,
): Promise<T> {
  const url = new URL(`${BASE}/${verb}`, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const r = await fetch(url.toString());
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
}) {
  return getJson<{ plans: PlanListRow[] }>('list', params);
}

export function fetchPlan(slug: string) {
  return getJson<PlanGetResult>('get', { slug });
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

/* ── Hooks ─────────────────────────────────────────────────────────── */

export interface AsyncResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function useAsyncJson<T>(fetcher: () => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

export function usePlanList(params?: {
  status?: PlanStatus;
  includeArchived?: boolean;
  includeLegacy?: boolean;
}) {
  return useAsyncJson(
    () => fetchPlanList(params),
    [params?.status, params?.includeArchived, params?.includeLegacy],
  );
}

export function usePlan(slug: string | null) {
  return useAsyncJson<PlanGetResult | null>(
    () => (slug ? fetchPlan(slug) : Promise.resolve(null)),
    [slug],
  );
}

export function usePlanItems(params?: {
  slug?: string;
  status?: ItemStatus;
  actionable?: boolean;
  needsHuman?: boolean;
}) {
  return useAsyncJson(
    () => fetchPlanItems(params),
    [params?.slug, params?.status, params?.actionable, params?.needsHuman],
  );
}

export function usePlanSearch(query: string) {
  return useAsyncJson<{ hits: PlanSearchHit[] }>(
    () =>
      query.trim()
        ? searchPlans({ query })
        : Promise.resolve({ hits: [] as PlanSearchHit[] }),
    [query],
  );
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
  /** Baseline `contentHash` from the `plans:get` that loaded the
   *  editor — the compare-and-swap guard. Omitted only if the server
   *  build predates the `contentHash` field. */
  expectedHash?: string;
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
  | { ok: true; slug?: string; filePath?: string; contentHash?: string }
  | {
      ok?: false;
      code?: string;
      error?: string;
      currentContent?: string;
      currentHash?: string;
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

/* ── Git history (P-303) ───────────────────────────────────────────── */

export interface GitCommit {
  hash: string;
  author: string;
  date: string; // ISO
  subject: string;
}

async function fetchPlanHistory(slug: string, archived: boolean): Promise<{ commits: GitCommit[] }> {
  const url = new URL('/api/admin/plans/git/history', window.location.origin);
  url.searchParams.set('slug', slug);
  if (archived) url.searchParams.set('archived', 'true');
  const r = await fetch(url.toString());
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`git/history → ${r.status}: ${text.slice(0, 200)}`);
  }
  return (await r.json()) as { commits: GitCommit[] };
}

export async function fetchPlanDiff(slug: string, archived: boolean, hash: string): Promise<string> {
  const url = new URL('/api/admin/plans/git/diff', window.location.origin);
  url.searchParams.set('slug', slug);
  if (archived) url.searchParams.set('archived', 'true');
  url.searchParams.set('hash', hash);
  const r = await fetch(url.toString());
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`git/diff → ${r.status}: ${text.slice(0, 200)}`);
  }
  const { diff } = (await r.json()) as { diff: string };
  return diff;
}

export function usePlanHistory(slug: string | null, archived: boolean): AsyncResult<GitCommit[]> {
  return useAsyncJson<GitCommit[]>(
    () => (slug ? fetchPlanHistory(slug, archived).then((r) => r.commits) : Promise.resolve([])),
    [slug, archived],
  );
}

/* ── plan_revisions (plan-agent-launch P-004 / P-017) ──────────────── */

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
  return useAsyncJson<PlanRevision[]>(
    () => (slug ? fetchPlanRevisions(slug).then((r) => r.revisions) : Promise.resolve([])),
    [slug],
  );
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
  return useAsyncJson<PlanRun[]>(
    () => (slug ? fetchPlanRuns(slug).then((r) => r.runs) : Promise.resolve([])),
    [slug],
  );
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
