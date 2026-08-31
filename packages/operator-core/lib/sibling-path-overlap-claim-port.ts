/**
 * sibling-path-overlap-claim-port — the claim-time "A SIBLING ALREADY TOUCHED YOUR
 * FILES" guard (EI-19329513980117751).
 *
 * THE CLASS THIS SURFACES: one root cause gets filed as several work-items, minutes
 * apart, by different agents who each described it differently. The 2026-08-02
 * identity-lint red produced three (WI-6878 mitigation, WI-6992 durable fix — already
 * landed, WI-6994 the SAME durable fix). An agent claimed WI-6994, implemented a
 * 159-line module, and only then read far enough to hit WI-6992's already-shipped
 * `redactProseCorpusFixture()`. git-sync had COMMITTED the duplicate before it was
 * caught, so the revert had to be a hand revert of a committed change.
 *
 * ⚠ WHY NOT SIMILARITY — THIS IS THE DESIGN DECISION, AND IT IS MEASURED. The obvious
 * build reads `harness_shared.dedup_edges` (migration 944), which ALREADY persists
 * create-time cosine sibling edges at cos>=0.85 and which nothing reads at claim time.
 * It does not work, in both directions at once (measured 2026-08-31 on this workspace):
 *
 *   - MISSES THE REAL PAIR. EI-19343733961745670 and EI-19454211066351073 are one
 *     duplicate ("lint:tsc prints error COUNTS but never the MESSAGES" vs "lint:tsc
 *     --files reports a COUNT delta but never the error TEXT"); ~90% of the first was
 *     already built by the second. There is NO edge between them at all — absence
 *     verified against a passing positive control.
 *   - DROWNS IT IN NEIGHBOURS. That same item carries 20+ edges at cos 0.88–0.94 to
 *     items that are merely topical.
 *
 * A cosine-ranked hint would therefore have been SILENT on the one pair that cost a
 * full session, while emitting twenty distractors — the worst shape an advisory can
 * have, because a noisy guard gets switched off and then the silence is invisible.
 * Duplicate FRAMINGS are exactly where prose diverges; the filer's own analysis put it
 * best: "What they did NOT diverge on is paths."
 *
 * PATH OVERLAP IS EXACT on every measured instance:
 *   WI-6992 + WI-6994          share prose-corpus.v1.json
 *   EI-19343733961745670 + EI-19454211066351073   share scripts/lint-tsc.mjs
 *
 * ⚠ THE LOOKBACK MUST INCLUDE SETTLED ITEMS, NOT JUST LIVE CLAIMS. In all three
 * measured instances the wasted work duplicated a sibling that was ALREADY DONE, so a
 * live-claims check would have missed every one. Settled siblings are ranked FIRST here
 * for that reason: an in-flight peer is a coordination problem, but a settled sibling
 * means the code may already be in the tree.
 *
 * ⚠ IMPLEMENTED, NOT MERELY SETTLED. `SETTLED_WORK_ITEM_STATES` includes the DISCARD
 * states (dropped/closed/deprecated), which mean the work was explicitly NOT done —
 * announcing one as "already implemented" would send an agent to read a decision to
 * skip the work as though it were the work. The implemented set is derived by
 * SUBTRACTION from that shared list rather than hand-listed, so a settled state added
 * upstream lands in the warned set by default: over-warning is recoverable (this is
 * advisory), staying silent is the defect this module exists to stop.
 *
 * ⚠ `lane='observation'` IS EXCLUDED. `harness_shared.work_items` also stores agents'
 * end-of-turn notes; they are ~92% of the naive population here (73,624 excluded vs
 * 2,673 claimable at the time of writing) and are not work anybody could duplicate.
 *
 * Fail-soft by design, mirroring every sibling port: a claim must never fail because an
 * advisory lookup did, and a swallowed read must never render as "the guard passed"
 * (the WI-6737 lesson).
 */
import { getOrgPg } from '@papercusp/db-org';
import { pathsOfPayload } from './stale-path-hints-claim-port';

/** How many siblings the warning will name. Beyond this the count is reported, not listed. */
export const MAX_SIBLINGS = 5;

/**
 * Terminal states that mean the work was DISCARDED rather than performed. Subtracted
 * from `SETTLED_WORK_ITEM_STATES` to derive the implemented set — see the module note
 * on why this is a subtraction and not a second hand-maintained list.
 */
export const DISCARDED_WORK_ITEM_STATES: readonly string[] = ['dropped', 'closed', 'deprecated'];

/** The settled states that mean the work actually LANDED. */
export function implementedWorkItemStates(settled: readonly string[]): string[] {
  return settled.filter((s) => !DISCARDED_WORK_ITEM_STATES.includes(s));
}

export interface PathOverlapSibling {
  workItemId: string;
  title: string;
  state: string;
  /** Held by an agent right now (a coordination collision rather than a done-already). */
  inFlight: boolean;
  /** The overlap itself — the evidence, not a similarity score. */
  sharedPaths: string[];
}

export interface ClaimTimeSiblingPathOverlapHint {
  /** The claimed item's own stored paths, as filed. */
  claimedPaths: string[];
  siblings: PathOverlapSibling[];
  /** Siblings whose work LANDED — the ones that may already be in the tree. */
  implementedCount: number;
  /** Siblings a peer holds right now. */
  inFlightCount: number;
}

interface SiblingRow {
  feature_id: string | null;
  title: string | null;
  status: string | null;
  in_flight: boolean | null;
  shared_paths: string[] | null;
}

/**
 * Work-items sharing at least one `payload.paths` entry with the claimed item, that
 * either already landed or are held by a peer right now. Null when the subject carries
 * no usable `payload.paths`, when nothing overlaps, or when the read failed — all three
 * are silence, because saying nothing asserts nothing.
 */
export async function getClaimTimeSiblingPathOverlap(ref: {
  workItemId: string;
  workItem?: { payload?: unknown } | null;
  payload?: unknown;
  harness?: string | null;
  workspaceId?: string | null;
}): Promise<ClaimTimeSiblingPathOverlapHint | null> {
  if (!ref.workItemId) return null;
  const payload = ref.payload ?? ref.workItem?.payload ?? null;
  const claimedPaths = pathsOfPayload(payload);
  if (!claimedPaths) return null;

  try {
    const { sql } = getOrgPg();
    // Loaded here rather than at module scope so the pure helpers above stay
    // dependency-free and cheap to unit-test, while the settled-state vocabulary stays
    // DERIVED from work-items.ts instead of copied (the repo's derived-truth rule).
    const { SETTLED_WORK_ITEM_STATES } = await import('./work-items');
    const settled = SETTLED_WORK_ITEM_STATES as string[];
    const implemented = implementedWorkItemStates(settled);

    const rows = await sql<SiblingRow[]>`
      SELECT feature_id,
             title,
             status,
             (taken_by IS NOT NULL AND status <> ALL(${settled})) AS in_flight,
             ARRAY(
               SELECT p.path
                 FROM jsonb_array_elements_text(payload->'paths') AS p(path)
                WHERE p.path = ANY(${claimedPaths})
             ) AS shared_paths
        FROM harness_shared.work_items
       WHERE feature_id IS DISTINCT FROM ${ref.workItemId}
         -- End-of-turn notes are not work anybody could duplicate; see the module note.
         AND lane IS DISTINCT FROM 'observation'
         -- jsonb_array_elements_text errors on a non-array, so gate before unnesting.
         AND jsonb_typeof(payload->'paths') = 'array'
         AND (status = ANY(${implemented}) OR (taken_by IS NOT NULL AND status <> ALL(${settled})))
         ${ref.workspaceId ? sql`AND workspace_id = ${ref.workspaceId}` : sql``}
         ${ref.harness ? sql`AND harness_slug = ${ref.harness}` : sql``}
         AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements_text(payload->'paths') AS p(path)
                WHERE p.path = ANY(${claimedPaths})
             )
       -- Settled first: an in-flight peer is a coordination problem, but a settled
       -- sibling means the code may already BE in the tree. See the module note.
       ORDER BY (status = ANY(${implemented})) DESC,
                closed_ts DESC NULLS LAST,
                updated_ts DESC NULLS LAST
       LIMIT ${MAX_SIBLINGS}`;

    const siblings: PathOverlapSibling[] = rows
      .filter((r) => r.feature_id && (r.shared_paths?.length ?? 0) > 0)
      .map((r) => ({
        workItemId: String(r.feature_id),
        title: String(r.title ?? ''),
        state: String(r.status ?? '').trim().toLowerCase(),
        inFlight: r.in_flight === true,
        sharedPaths: (r.shared_paths ?? []).map(String),
      }));
    if (siblings.length === 0) return null;

    return {
      claimedPaths,
      siblings,
      implementedCount: siblings.filter((s) => !s.inFlight).length,
      inFlightCount: siblings.filter((s) => s.inFlight).length,
    };
  } catch {
    return null;
  }
}

/**
 * Render the hint as the line an agent reads at claim time. Pure + exported so the
 * guarantee is directly testable and a future edit cannot silently weaken it — the
 * shape `planItemLandedWarning` and `priorWorkWarning` chose, for the same reason.
 *
 * The message names the SHARED PATHS rather than a score, because the path list is both
 * the evidence and the next action: it is exactly what to read before the first edit.
 */
export function siblingPathOverlapWarning(
  hint: ClaimTimeSiblingPathOverlapHint | null,
  workItemId: string,
): string | null {
  if (!hint || hint.siblings.length === 0) return null;
  const list = hint.siblings
    .map(
      (s) =>
        `${s.workItemId} (${s.inFlight ? 'IN FLIGHT' : s.state}, shares ${s.sharedPaths.length}: ` +
        `${s.sharedPaths.join(', ')})`,
    )
    .join('; ');
  const landed =
    hint.implementedCount > 0
      ? `${hint.implementedCount} of them ALREADY LANDED, so the code may already be in the tree. `
      : '';
  const inFlight =
    hint.inFlightCount > 0
      ? `${hint.inFlightCount} is held by a peer RIGHT NOW — coordinate before editing. `
      : '';
  return (
    `⚠ SIBLING ITEMS TOUCH YOUR PATHS: ${hint.siblings.length} other work-item(s) share ` +
    `stored payload paths with ${workItemId}: ${list}. ${landed}${inFlight}` +
    `One root cause is routinely filed several times in minutes by different agents, and the ` +
    `framings diverge in PROSE while agreeing on PATHS — which is why this is a path check and ` +
    `not a similarity score (EI-19329513980117751: a 159-line duplicate was written and ` +
    `COMMITTED before the already-shipped original was noticed). Before writing ANYTHING: read ` +
    `the settled sibling's completion evidence and open the shared files. If the work already ` +
    `landed, close ${workItemId} as a duplicate with that evidence instead of re-implementing; ` +
    `if it genuinely did not, say so in a comment and proceed. [EI-19329513980117751]`
  );
}
