/**
 * ungraded-filings-watchdog.ts — the su-ideate GRADING backstop
 * (su-ideate-learning-substrate-2026-07-10 P-006).
 *
 * THE STARVATION (the gap this closes): su sessions now ORIGINATE feature ideas
 * (improvements:capture kind:'feature' → origin='su-ideate' rows on the routed-idea
 * ledger), and the whole learning substrate — grader-feedback priming, per-lens
 * win-credit, the P-005 grade→revise wake — runs on those rows being GRADED
 * (blender:grade-idea). But nothing MAKES grading happen: the Mug only grades when
 * triage happens to look, so su filings sit with human_grade NULL indefinitely and
 * the loop never gets its teaching signal (live sizing 2026-07-10: 0 of 85 su-ideate
 * rows ever graded — D-013 "the gap is forward-looking").
 *
 * THE FIX (deadline → friction wake): a deterministic, zero-token sweep on the
 * existing 30s routinesTick — a straight port of draft-review-watchdog.ts
 * (selectStaleDrafts / shouldNudgeHive / fireReviewWake), aimed at ledger rows
 * instead of draft plans. For each STARTED pot it finds origin='su-ideate' rows that
 * are ungraded (human_grade IS NULL), whose routed artifact is still NON-TERMINAL,
 * older than SU_IDEATE_UNGRADED_STALE_SEC (default 7d), and fires ONE debounced WAKE
 * to the live Mug naming the filings — the blender:grade-idea path (by ideaId or
 * routedRef) already exists, the nudge just puts it on the friction path. It NEVER
 * grades anything itself (that would fake the signal — and D-012 exists precisely
 * because a watchdog-prompted grader must still not be the author).
 *
 * D-013 flood guards (the backfilled corpus must NOT flood triage): the sweep only
 * ever nudges rows routed AFTER its enablement epoch (SU_IDEATE_UNGRADED_EPOCH_MS —
 * the 85-row pre-P-006 corpus stays silent; P-016's backfill gives it outcomes, not
 * nudges) and each fire carries at most SU_IDEATE_UNGRADED_BATCH_CAP filings.
 *
 * Non-terminal check: the ledger's own `outcome` CACHE column (won | lost | pending,
 * NULL until a refresh sweeps the row — P-003/P-016). 'won'/'lost' rows are excluded
 * (the artifact already decided; the outcome IS the signal); NULL is treated as
 * non-terminal on purpose — better to nudge a grade on a row the cache hasn't caught
 * up with (a grade on a decided idea still feeds win-credit) than to starve the loop
 * waiting for a sweep. Same fail-soft shape as the template: pure deciders split
 * from the PG sweep, env-tunable threshold with a `<=0` kill switch, per-pot
 * debounce over `hive_watchdog_fires` (source='su-ideate-ungraded'), never throws
 * into the routines tick. DEFAULT-SAFE: no stale ungraded filing ⇒ nothing happens.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listStartedPots } from '../pot/started';
import { resolveMugOwner } from '../pot/placement-watchdog';
import { recentWatchdogFires, recordFire } from '../pot/watchdog';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';

// ── tunables (env-overridable, like scoutDraftReviewStaleSec) ─────────────────

/** How long an su-ideate filing may sit ungraded (human_grade still NULL, artifact
 *  non-terminal) before the backstop nudges Mug triage to grade it. Default 7d;
 *  env-tunable via PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC; `<=0` DISABLES the whole
 *  sweep (kill switch). */
export function suIdeateUngradedStaleSec(): number {
  const n = Number(process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC ?? 604_800);
  return Number.isFinite(n) ? n : 604_800;
}

/** D-013 enablement-epoch floor: only rows routed AFTER the watchdog shipped are
 *  ever nudged — the pre-existing su-ideate corpus (85 rows at sizing) belongs to
 *  the P-016 backfill sweep (outcomes), never to triage nudges. */
export const SU_IDEATE_UNGRADED_EPOCH_MS = Date.parse('2026-07-11T00:00:00Z');

/** D-013 batch cap: one fire names at most this many filings (oldest first), so
 *  even a future pile-up arrives in triage as a bounded, workable batch. */
export const SU_IDEATE_UNGRADED_BATCH_CAP = 10;

// ── pure deciders (unit-tested with no DB) ────────────────────────────────────

/** One ungraded su-ideate ledger row (origin='su-ideate', human_grade IS NULL,
 *  outcome cache non-terminal). */
export interface SuUngradedCandidate {
  ideaId: string;
  title: string | null;
  /** Change-feed ref of the routed artifact — the blender:grade-idea handle. */
  routedRef: string;
  /** Epoch ms the filing was routed (scout_routed_ideas.routed_at). */
  routedAtMs: number;
}

/**
 * PURE: which candidate filings are stale enough to nudge — ungraded at least
 * `thresholdMs`, routed at/after the D-013 epoch floor, oldest first, capped at
 * `cap` (D-013 batch cap). A `thresholdMs <= 0` (kill switch) selects none. A
 * non-finite timestamp is never selected (don't act blind on a missing clock).
 */
export function selectUngradedFilings(
  candidates: readonly SuUngradedCandidate[],
  opts: { now: number; thresholdMs: number; epochMs?: number; cap?: number },
): SuUngradedCandidate[] {
  if (opts.thresholdMs <= 0) return []; // kill switch
  const epochMs = opts.epochMs ?? SU_IDEATE_UNGRADED_EPOCH_MS;
  const cap = opts.cap ?? SU_IDEATE_UNGRADED_BATCH_CAP;
  return candidates
    .filter(
      (c) =>
        Number.isFinite(c.routedAtMs) &&
        c.routedAtMs >= epochMs &&
        opts.now - c.routedAtMs >= opts.thresholdMs,
    )
    .sort((a, b) => a.routedAtMs - b.routedAtMs)
    .slice(0, Math.max(0, cap));
}

/**
 * PURE: should this pot get a grading nudge this tick? Only when there IS a stale
 * ungraded filing and we have not already fired within the debounce window (a filing
 * that stays ungraded across many 30s ticks nudges the Mug at most once per window).
 */
export function shouldNudgeMug(args: { staleCount: number; alreadyFiredRecently: boolean }): boolean {
  return args.staleCount > 0 && !args.alreadyFiredRecently;
}

// ── the PG sweep ──────────────────────────────────────────────────────────────

interface UngradedRow {
  idea_id: string;
  title: string | null;
  routed_ref: string;
  routed_at: string | number | null;
}

/** Read this pot's ungraded su-ideate candidates (epoch-floored in SQL for
 *  cheapness; the pure decider re-applies it plus the threshold + cap). Unlike the
 *  draft watchdog's harness_plans read there is no workspace subtlety here: the
 *  ledger row carries the pot's REAL workspace_id + harness_slug (the capture
 *  bridge stamps both), which is exactly what listStartedPots hands the sweep. */
export async function readUngradedSuFilings(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  opts: { limit?: number } = {},
): Promise<SuUngradedCandidate[]> {
  const limit = opts.limit ?? 50;
  const rows = await sql<UngradedRow[]>`
    SELECT idea_id, title, routed_ref, routed_at
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${installSlug}
       AND origin = 'su-ideate'
       AND human_grade IS NULL
       AND (outcome IS NULL OR outcome = 'pending')
       AND routed_at >= ${SU_IDEATE_UNGRADED_EPOCH_MS}
     ORDER BY routed_at ASC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    ideaId: r.idea_id,
    title: r.title,
    routedRef: r.routed_ref,
    routedAtMs: Number(r.routed_at ?? 0),
  }));
}

export interface SuUngradedSweepResult {
  workspaceId: string;
  installSlug: string;
  outcome: 'nudged' | 'skipped' | 'error';
  staleCount: number;
  reason: string;
}

/**
 * Fire ONE grading nudge to the live Mug naming the stale ungraded filings. It NEVER
 * writes a grade — the Mug still judges (and per D-012 must not be the author).
 *
 * Delivery is the WI-963 two-half shape the draft watchdog converged on: the
 * event-key wake to the resolved Mug owner is BEST-EFFORT (that owner id is often a
 * fresh-per-wake session already ended by sweep time), so we ALSO durably park an
 * `@role:mug`-addressed coord message — the slot mug-brief-launch.ts drains into
 * EVERY future Mug wake's brief regardless of which owner id it boots under. The
 * durable park is the reliable half; the wake is the bonus.
 */
export async function fireGradingNudge(
  workspaceId: string,
  mugOwner: string,
  stale: readonly SuUngradedCandidate[],
  staleSec: number,
): Promise<void> {
  const days = Math.max(1, Math.round(staleSec / 86_400));
  const shown = stale.slice(0, 5);
  const list = shown
    .map((s) => `• ${s.ideaId}${s.title ? ` — ${s.title}` : ''} (${s.routedRef})`)
    .join('\n');
  const more = stale.length > shown.length ? `\n…and ${stale.length - shown.length} more.` : '';
  const summary =
    `su-ideate grading backstop: ${stale.length} su-originated filing(s) ungraded > ${days}d. ` +
    `Grade each via blender:grade-idea { ideaId, grade, feedback } — grades feed the originator's ` +
    `priming + lens win-rates, and a grade of 3 or lower with feedback wakes the originator to ` +
    `revise. Grading them (or their artifacts reaching a terminal state) stops this nudge.\n\n` +
    `${list}${more}`;
  await wakeRecipients([mugOwner], {
    summary,
    payload: {
      kind: 'su-ideate-ungraded',
      ideaIds: stale.map((s) => s.ideaId),
      refs: stale.map((s) => s.routedRef),
      staleDays: days,
    },
    source: 'su-ideate-ungraded',
    workspaceId,
  });
  // The durable half — best-effort: a park failure must never break the sweep (the
  // caller's try/catch also guards this, but degrade locally too so a park hiccup
  // doesn't mask the wake attempt above having already happened).
  try {
    const [{ sendMessage }, { runWithWorkspace }] = await Promise.all([
      import('../agent-tools/coordination/messages'),
      import('../workspace-als'),
    ]);
    await runWithWorkspace(workspaceId, () =>
      sendMessage(
        {
          ownerId: 'su-ideate-ungraded-watchdog',
          ownerLabel: 'su-ideate-ungraded-watchdog',
          source: 'static-client',
          workspaceId,
          userId: null,
        },
        { to: ['@role:mug'], summary, body: `${list}${more}` },
      ),
    );
  } catch (e) {
    console.warn(`[su-ideate-ungraded] @role:mug park failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * The ungraded su-filings backstop sweep. For each STARTED pot: find su-ideate
 * filings ungraded past the deadline (epoch-floored, batch-capped — D-013), and
 * (debounced per-pot) nudge the live Mug to grade them. Never throws — a watchdog
 * that crashes its host guards nothing. DEFAULT-SAFE: no stale ungraded filing ⇒
 * no nudge. Kill switch: PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC <= 0.
 */
export async function suIdeateUngradedSweep(opts: { now?: number } = {}): Promise<SuUngradedSweepResult[]> {
  const results: SuUngradedSweepResult[] = [];
  const staleSec = suIdeateUngradedStaleSec();
  if (staleSec <= 0) return results; // kill switch
  try {
    const started = await listStartedPots();
    if (started.length === 0) return results;
    const { sql } = getOrgPg();
    const now = opts.now ?? Date.now();
    const thresholdMs = staleSec * 1_000;
    const days = Math.max(1, Math.round(staleSec / 86_400));
    const windowHours = Math.max(1, Math.round(staleSec / 3_600));
    for (const { workspaceId, installSlug } of started) {
      try {
        const candidates = await readUngradedSuFilings(sql, workspaceId, installSlug);
        const stale = selectUngradedFilings(candidates, { now, thresholdMs });
        if (stale.length === 0) continue;
        const alreadyFiredRecently =
          (await recentWatchdogFires(workspaceId, installSlug, windowHours, 'su-ideate-ungraded')) > 0;
        if (!shouldNudgeMug({ staleCount: stale.length, alreadyFiredRecently })) {
          results.push({ workspaceId, installSlug, outcome: 'skipped', staleCount: stale.length, reason: 'debounced' });
          continue;
        }
        const mugOwner = await resolveMugOwner(sql, workspaceId, installSlug);
        if (!mugOwner) {
          results.push({
            workspaceId,
            installSlug,
            outcome: 'skipped',
            staleCount: stale.length,
            reason: 'no live Mug session to wake',
          });
          continue;
        }
        const reason =
          `${stale.length} su-ideate filing(s) ungraded > ${days}d: ` +
          stale.slice(0, 5).map((s) => s.ideaId).join(', ');
        await fireGradingNudge(workspaceId, mugOwner, stale, staleSec);
        // Record the fire so the debounce engages next tick (source='su-ideate-ungraded').
        await recordFire({ workspaceId, installSlug, source: 'su-ideate-ungraded', reason, wakeAt: null });
        results.push({ workspaceId, installSlug, outcome: 'nudged', staleCount: stale.length, reason });
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          staleCount: 0,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[su-ideate-ungraded] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
