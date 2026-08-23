/**
 * useInboxBulkRun — the Inbox BULK RESOLVE run's client seam
 * (inbox-bulk-resolve-2026-08-23, P-006).
 *
 * ONE sync subscription (`plans.attentionBulkRun`) plus the four owner-side ops
 * the command strip fires. Split out of InboxPane so the pane keeps its single
 * responsibility — rendering the attention feed — and so the strip's behavior is
 * unit-testable without mounting a virtualized list.
 *
 * REUSE, not re-derivation. The run's state lives in Postgres and arrives on the
 * SAME SSE-invalidated sync transport every other pane query uses, so:
 *   - reopening the pane resumes into the run's current phase instead of losing
 *     it to unmounted component state (Requirement 7), and
 *   - the resolver agent's writes reach the strip by the same push the rest of
 *     the app uses — no polling loop of our own.
 *
 * ⚠ ACCEPTING A RECOMMENDATION DISPATCHES THE CLIENT PATH, NOT A SERVER RE-DERIVE.
 * `acceptRecommendation` calls `resolveAttentionAction` / `replyToAttentionItem`
 * from attention-card.ts — the exact helpers a hand resolve uses — and only THEN
 * records the acceptance on the run. That ordering is the point (D-003): the
 * asker wake, the provenance and the triage audit note are produced by one
 * implementation, so a bulk accept and a hand resolve can never drift apart. The
 * record write is deliberately second and best-effort: an accepted item whose
 * bookkeeping write failed is a stale counter, while a recorded acceptance whose
 * resolve failed is a LIE about something done on the owner's behalf.
 */
import { useCallback, useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { AttentionItem } from '@/app/admin/plans/plans-api';
import {
  isNavigateAction,
  replyToAttentionItem,
  resolveAttentionAction,
} from '@/app/admin/plans/attention-card';

/** Mirrors `BulkRunPhase` in packages/operator-core/lib/attention/bulk-run-store.ts. */
export type BulkRunPhase = 'pending' | 'running' | 'review' | 'complete' | 'failed';

/** Mirrors `BulkItemOutcome` in the same store. */
export type BulkItemOutcome = 'pending' | 'auto_resolved' | 'recommended' | 'skipped' | 'failed';

/** The run row as the sync query returns it (`BulkRunRow` on the wire). */
export interface BulkRun {
  runId: string;
  phase: BulkRunPhase;
  totalItems: number;
  autoResolved: number;
  recommended: number;
  skipped: number;
  failed: number;
  error: string | null;
  filterSnapshot?: {
    tier?: string | null;
    kinds?: string[];
    query?: string | null;
    shownCount?: number | null;
  };
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One item's outcome as the sync query returns it (`BulkRunItemRow`). */
export interface BulkRunItem {
  runId: string;
  itemId: string;
  position: number;
  kind: string | null;
  title: string | null;
  outcome: BulkItemOutcome;
  actionId: string | null;
  rationale: string | null;
  draftAnswer: string | null;
  confidence: 'low' | 'high' | null;
  consulted: boolean;
  consultReply: string | null;
  error: string | null;
  decidedAt: string | null;
}

export interface BulkRunState {
  run: BulkRun | null;
  items: BulkRunItem[];
  /** Item-id → outcome row, for the per-row status badges. */
  byItemId: Map<string, BulkRunItem>;
  /** Items still awaiting the owner's call. */
  recommendations: BulkRunItem[];
  /** Items the resolver never reached (a stopped or failed run). */
  unreached: BulkRunItem[];
  /** The run is live: the resolver is still working. */
  isRunning: boolean;
  /** The run is waiting on the owner. */
  isReview: boolean;
  loading: boolean;
}

/** What a start POST hands back. */
export interface StartResult {
  ok: boolean;
  runId?: string;
  launched?: boolean;
  launchError?: string;
  error?: string;
}

/** The seed one item contributes to a run — the pane's own snapshot of it. */
export interface BulkSeedItem {
  itemId: string;
  kind: string;
  title: string | null;
  ref: unknown;
  ownerAgentId: string | null;
}

const ENDPOINT = '/api/admin/attention-bulk-resolve';

/** Phases in which the strip is showing a live run rather than its idle button. */
export function isActivePhase(phase: BulkRunPhase | null | undefined): boolean {
  return phase === 'pending' || phase === 'running' || phase === 'review';
}

/**
 * The strip's headline counts. Derived from the ITEM ROWS, never from the run's
 * denormalized counters: the counters are recomputed asynchronously after each
 * report, so during a run they can trail the rows the same render is showing —
 * and a progress bar that disagrees with the list beneath it reads as a bug in
 * the resolver rather than in the arithmetic.
 */
export function deriveRunCounts(items: BulkRunItem[], run: BulkRun | null): {
  total: number;
  resolved: number;
  forReview: number;
  skipped: number;
  failed: number;
  left: number;
  decided: number;
  percent: number;
} {
  let resolved = 0;
  let forReview = 0;
  let skipped = 0;
  let failed = 0;
  for (const i of items) {
    if (i.outcome === 'auto_resolved') resolved += 1;
    else if (i.outcome === 'recommended') forReview += 1;
    else if (i.outcome === 'skipped') skipped += 1;
    else if (i.outcome === 'failed') failed += 1;
  }
  // `totalItems` is authoritative for the DENOMINATOR even when rows are still
  // arriving: the run knows how many items it was handed, and dividing by the
  // rows received so far would show a bar that sits at 100% from the first
  // report and slides BACKWARD as more rows land.
  const total = run?.totalItems ?? items.length;
  const decided = resolved + forReview + skipped + failed;
  return {
    total,
    resolved,
    forReview,
    skipped,
    failed,
    decided,
    left: Math.max(0, total - decided),
    percent: total > 0 ? Math.min(100, Math.round((decided / total) * 100)) : 0,
  };
}

async function postOp(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = json?.error as { message?: string } | undefined;
    throw new Error(err?.message ?? `bulk-resolve ${String(body.op ?? 'start')} failed (${res.status})`);
  }
  return json;
}

/**
 * Subscribe to the run the strip should be showing.
 *
 * `runId` is the `?opcbr=` deep link. Passing none reads the workspace's LATEST
 * run, which is the pane's real opening question ("is there a run I should be
 * showing?") — see the resolver's note in sync-resolver/index.ts.
 */
export function useInboxBulkRun(runId?: string | null): BulkRunState {
  const { data, loading } = useSyncQuery<{ run: BulkRun | null; items: BulkRunItem[] }>({
    queryName: 'plans.attentionBulkRun',
    args: runId ? { runId } : {},
  });

  const row = Array.isArray(data) ? data[0] : (data as { run?: BulkRun | null } | undefined);
  const run = (row?.run ?? null) as BulkRun | null;
  const items = useMemo(
    () => ((row as { items?: BulkRunItem[] } | undefined)?.items ?? []) as BulkRunItem[],
    [row],
  );

  return useMemo(() => {
    const byItemId = new Map<string, BulkRunItem>();
    for (const i of items) byItemId.set(i.itemId, i);
    return {
      run,
      items,
      byItemId,
      recommendations: items.filter((i) => i.outcome === 'recommended'),
      unreached: items.filter((i) => i.outcome === 'pending'),
      isRunning: run?.phase === 'running' || run?.phase === 'pending',
      isReview: run?.phase === 'review',
      loading: Boolean(loading),
    };
  }, [run, items, loading]);
}

/** The owner-side ops, as stable callbacks. */
export function useBulkRunOps(): {
  start: (items: BulkSeedItem[], filter: Record<string, unknown>, harness?: string | null) => Promise<StartResult>;
  stop: (runId: string) => Promise<void>;
  dismiss: (runId: string) => Promise<void>;
  acceptRecommendation: (
    runId: string,
    item: AttentionItem,
    rec: BulkRunItem,
  ) => Promise<{ ok: boolean; error?: string }>;
} {
  const start = useCallback(
    async (
      seed: BulkSeedItem[],
      filter: Record<string, unknown>,
      harness?: string | null,
    ): Promise<StartResult> => {
      try {
        const json = await postOp({
          items: seed,
          filter,
          ...(harness ? { harness } : {}),
        });
        return {
          ok: true,
          runId: typeof json.runId === 'string' ? json.runId : undefined,
          launched: json.launched === true,
          launchError: typeof json.launchError === 'string' ? json.launchError : undefined,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [],
  );

  const stop = useCallback(async (runId: string) => {
    await postOp({ op: 'stop', runId });
  }, []);

  const dismiss = useCallback(async (runId: string) => {
    await postOp({ op: 'dismiss', runId });
  }, []);

  const acceptRecommendation = useCallback(
    async (runId: string, item: AttentionItem, rec: BulkRunItem) => {
      const actionId = rec.actionId;
      if (!actionId) return { ok: false, error: 'recommendation names no action' };

      // A navigate-only option opens a sub-surface and resolves NOTHING. Accepting
      // one would record a resolution that never happened — the exact defect that
      // once let Discuss silently close real owner gates (EI-13037). The resolver
      // is told never to recommend one; this is the client-side backstop.
      if (isNavigateAction(actionId)) {
        return { ok: false, error: `"${actionId}" only opens a view — it resolves nothing` };
      }

      try {
        // RESOLVE FIRST, RECORD SECOND (see the file header). A draft answer means
        // the item's path takes free text, so the owner's accept must DELIVER that
        // text to the asking agent, not just close the card.
        const draft = rec.draftAnswer?.trim();
        const outcome = draft
          ? await replyToAttentionItem(item, draft)
          : await resolveAttentionAction(item, actionId);
        if (!outcome.resolved) {
          return { ok: false, error: 'the item did not accept that action' };
        }

        await postOp({
          op: 'accept',
          runId,
          itemId: rec.itemId,
          actionId,
          note: rec.rationale ?? null,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [],
  );

  return { start, stop, dismiss, acceptRecommendation };
}
