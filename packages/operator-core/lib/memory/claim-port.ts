/**
 * Claim-time recall port (memory-delivery-unification-2026-07-12 P-008,
 * decision D-006): a work-item CLAIM is the moment the session's intent gets
 * maximally specific — so every claim verb (work_items:claim / claim_next /
 * pickup, scheduler:get_next, the plans:set-status→wip auto-claim,
 * coord:orient's planItems lane) piggybacks a targeted memory recall on its
 * response instead of making the agent pay a separate memory:search
 * round-trip it in practice never makes.
 *
 * One shared service, per D-006 — the ports differ only in query
 * construction + budget:
 *   - WHAT: one query per claimed item — `title — <summary head>` (the
 *     resolver's plan rung; D-005's no-mega-query rule), plus the parent
 *     plan's ## Now when a spare slot remains.
 *   - WHERE: the claimed items' dominant harness dims (hive-pool resolution
 *     stays inside injection.ts).
 *   - Admission: the ONE pipeline (floors · muted packs · tombstones ·
 *     session-epoch dedup · budget) via buildLaunchMemoryBlock; stamps the
 *     SHARED port-agnostic epoch ledger (port 'claim'), so an orient-then-
 *     claim sequence never double-injects the same memory.
 *   - Budget: ~3.5k chars — a claim response is not a brief.
 *
 * Never-throws + deadline-bounded (default 2s, env-tunable): a recall outage
 * or slow embed must never fail — or materially delay — a claim.
 */
import { resolveLaunchProfile, buildLaunchMemoryBlock } from './launch-profile';
import { dominantHarness } from './compact-reprime';
import { activeWorkspaceId } from '../workspace-registry';

export interface ClaimRecallItem {
  id?: string | null;
  title?: string | null;
  /** Body head (the work-item summary) — folded into the query after the title. */
  summary?: string | null;
  harness?: string | null;
}

export interface ClaimRecallInput {
  /** Warm-session epoch-dedup identity (the claimer's ownerId). Optional —
   *  recall still runs without it, just un-stamped (no dedup ledger). */
  sessionId?: string | null;
  workspaceId?: string | null;
  items: readonly ClaimRecallItem[];
  /** The parent plan's ## Now line (plan-bound claims) — fills a spare query slot. */
  planNow?: string | null;
  /** Epoch-ledger port stamp (default 'claim'; the create port passes 'create'). */
  port?: string;
  deadlineMs?: number;
  heading?: string;
}

export const CLAIM_RECALL_HEADING =
  'Claim recall (fuzzy memory — may be stale; verify before relying on it)';

/** ~3–4k char budget per P-008 — bounded so recall never dominates the response. */
export const CLAIM_RECALL_BUDGET_CHARS = 3500;

/** Max summary-head chars folded into each per-item query (the query is a
 *  STATEMENT, not a document — launch-profile clamps to 300 total anyway). */
const SUMMARY_HEAD_CHARS = 200;

const DEFAULT_DEADLINE_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_CLAIM_RECALL_DEADLINE_MS ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
})();

/** `title — <summary head>` (id fallback for a blank title). */
export function claimRecallQueryOf(it: ClaimRecallItem): string {
  const title = (it.title ?? '').trim() || (it.id ?? '').trim();
  if (!title) return '';
  const head = (it.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_HEAD_CHARS);
  return head ? `${title} — ${head}` : title;
}

/** Local deadline race (same posture as _mcp-handler's raceDeadline — kept
 *  local so memory/* never depends on the transport layer). 0 = unbounded. */
async function withDeadline<T>(deadlineMs: number, run: () => Promise<T>, onTimeout: () => T): Promise<T> {
  const p = run();
  if (!(deadlineMs > 0)) return p;
  p.catch(() => {}); // the orphaned branch must never surface as unhandledRejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build the claim-time recall block for just-claimed item(s). Returns null on
 * no material, no hits past the admission floors, timeout, or ANY failure.
 */
export async function buildClaimRecallBlock(input: ClaimRecallInput): Promise<string | null> {
  try {
    const queries = input.items.map(claimRecallQueryOf).filter((q) => q.length > 0);
    if (queries.length === 0) return null;
    const workspaceId = input.workspaceId?.trim() || activeWorkspaceId();
    const profile = resolveLaunchProfile({
      harnessSlug: dominantHarness(
        input.items.map((it) => ({ harness: it.harness ?? null })),
      ),
      claimedItemTitles: queries,
      planNow: input.planNow ?? null,
    });
    return await withDeadline(
      input.deadlineMs ?? DEFAULT_DEADLINE_MS,
      () =>
        buildLaunchMemoryBlock({
          profile,
          workspaceId,
          budgetChars: CLAIM_RECALL_BUDGET_CHARS,
          limit: 4,
          ...(input.sessionId
            ? { session: { sessionId: input.sessionId, port: input.port ?? 'claim' } }
            : {}),
          heading: input.heading ?? CLAIM_RECALL_HEADING,
        }),
      () => null,
    );
  } catch {
    return null; // never-throws: recall must never fail a claim
  }
}
