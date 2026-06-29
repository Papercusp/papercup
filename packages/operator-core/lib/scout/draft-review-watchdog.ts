/**
 * draft-review-watchdog.ts — the Queen↔Scout feedback-loop ANTI-STARVATION backstop
 * (queen-scout-feedback-loop-2026-06-20 D-003 #2, hardening).
 *
 * THE STARVATION (the root cause this closes): the Scout produces draft plans on a
 * friction-OR-idle cadence (the bp-singleton-scout-0 blueprint, every 30m) and pings
 * the Queen via a DURABLE coord message with NO forced wake (queen-notify.ts:
 * notifyQueenDraftRouted → `send`, never `wakeRecipients` — "review is idle-gated per
 * D-003 #2; placement always wins"). So the Queen only REVIEWS scout-routed drafts on
 * an IDLE wake (the `plan-review` idle activity). When the hive's bee slots are
 * chronically full ("fleet saturated"), the Queen is NEVER idle → review never runs →
 * scout-routed drafts (status='draft', origin='scout') sit unreviewed for days, neither
 * ratified (launched) nor deprecated-with-learnings. The Scout keeps producing; the
 * Queen never consumes; the link starves.
 *
 * THE FIX (deadline → friction wake): a deterministic, zero-token sweep on the existing
 * 30s routinesTick. For each STARTED hive it finds scout-routed drafts that have been
 * unreviewed past a deadline and fires ONE debounced WAKE to the live Queen — moving the
 * stale draft off the idle-only path onto the FRICTION wake path, so review competes as
 * normal work. It NEVER ratifies or deprecates a draft (that would fake the link); the
 * Queen still disposes (promote / iterate / deprecate-with-learnings). It is a BACKSTOP,
 * not a cadence: every check is a cheap SQL read and the wake is the exception path.
 *
 * Mirrors the hive watchdog patterns (hive/watchdog.ts pausedHiveRecoverySweep +
 * hive/placement-watchdog.ts fireRecoveryWake): pure deciders split from the PG sweep,
 * env-tunable threshold with a `<=0` kill switch, per-hive debounce over the existing
 * `hive_watchdog_fires` ledger (source='scout-draft-review'), and fail-soft throughout —
 * a watchdog that throws into its caller guards nothing. DEFAULT-SAFE: when no draft is
 * stale it does nothing (no behavior change).
 *
 * Where the drafts live (storage, verified against LIVE data 2026-06-29): the DRAFT row
 * is `harness_shared.harness_plans` under the HIVE's OWN workspace_id (e.g.
 * 'papercusp-workspace' — NOT 'default'; the sweep passes the started-hive workspaceId),
 * harness_slug = the hive slug, status='draft', `origin: scout` in the `content`
 * frontmatter, and `updated_at` (auto-bumped on every write — a scout revision off Queen
 * feedback resets the clock, which is correct: the draft was just touched). The
 * scout_routed_ideas ledger carries the same draft under the hive's REAL workspace, so a
 * cross-table workspace join would not line up — origin is read from the plan's own
 * frontmatter instead.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listStartedHives } from '../hive/started';
import { resolveQueenOwner } from '../hive/placement-watchdog';
import { recentWatchdogFires, recordFire } from '../hive/watchdog';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';

// ── tunable (env-overridable, like the liveness-watchdog floor) ───────────────

/** How long a scout-routed draft may sit unreviewed (status still 'draft', untouched)
 *  before the backstop wakes the Queen to review it. Default 12h; env-tunable; `<=0`
 *  DISABLES the whole sweep (kill switch). */
export function scoutDraftReviewStaleSec(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC ?? 43_200);
  return Number.isFinite(n) ? n : 43_200;
}

// ── pure deciders (unit-tested with no DB) ────────────────────────────────────

/** One scout-routed draft candidate (a status='draft', origin='scout' plan row). */
export interface ScoutDraftCandidate {
  planSlug: string;
  title: string | null;
  /** Epoch ms of the draft row's last write (harness_plans.updated_at). */
  updatedAtMs: number;
}

/**
 * PURE: which candidate drafts are stale enough to nudge — unreviewed at least
 * `thresholdMs`, oldest first. A `thresholdMs <= 0` (kill switch) selects none. A
 * non-finite timestamp is never selected (don't act blind on a missing clock).
 */
export function selectStaleDrafts(
  candidates: readonly ScoutDraftCandidate[],
  opts: { now: number; thresholdMs: number },
): ScoutDraftCandidate[] {
  if (opts.thresholdMs <= 0) return []; // kill switch
  return candidates
    .filter((c) => Number.isFinite(c.updatedAtMs) && opts.now - c.updatedAtMs >= opts.thresholdMs)
    .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
}

/**
 * PURE: should this hive get a review wake this tick? Only when there IS a stale draft
 * and we have not already fired within the debounce window (so a draft that stays stale
 * across many 30s ticks wakes the Queen at most once per window, not every tick).
 */
export function shouldNudgeHive(args: { staleCount: number; alreadyFiredRecently: boolean }): boolean {
  return args.staleCount > 0 && !args.alreadyFiredRecently;
}

// ── the PG sweep ──────────────────────────────────────────────────────────────

interface DraftRow {
  plan_slug: string;
  title: string | null;
  updated_at_ms: string | number | null;
}

/** Read this hive's scout-routed DRAFT candidates (no time filter — the pure decider
 *  applies the threshold). Scout-origin is read from the plan's own frontmatter
 *  (`origin: scout`), which both scout rails write. `planWorkspaceId` MUST be the hive's
 *  OWN workspace — where the scout plan rows actually live (verified 'papercusp-workspace',
 *  NOT 'default'); the sweep passes the started-hive workspaceId. */
export async function readScoutDraftCandidates(
  sql: Sql,
  planWorkspaceId: string,
  installSlug: string,
  opts: { limit?: number } = {},
): Promise<ScoutDraftCandidate[]> {
  const limit = opts.limit ?? 50;
  const rows = await sql<DraftRow[]>`
    SELECT plan_slug, title,
           (extract(epoch FROM updated_at) * 1000)::bigint AS updated_at_ms
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${planWorkspaceId}
       AND harness_slug = ${installSlug}
       AND status = 'draft'
       AND archived = false
       AND content LIKE ${'%\norigin: scout\n%'}
     ORDER BY updated_at ASC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    planSlug: r.plan_slug,
    title: r.title,
    updatedAtMs: Number(r.updated_at_ms ?? 0),
  }));
}

export interface ScoutDraftReviewResult {
  workspaceId: string;
  installSlug: string;
  outcome: 'nudged' | 'skipped' | 'error';
  staleCount: number;
  reason: string;
}

/** Fire ONE review wake to the live Queen so she reviews the stale drafts on the FRICTION
 *  path (not the idle-only path). Best-effort: a woken:0 (Queen has no armed wake) degrades
 *  to "she sees these on her next natural turn"; the liveness watchdog keeps her armed.
 *  Crucially it NEVER touches the draft status — the Queen still ratifies / deprecates. */
async function fireReviewWake(
  workspaceId: string,
  queenOwner: string,
  stale: readonly ScoutDraftCandidate[],
  staleSec: number,
): Promise<void> {
  const hours = Math.max(1, Math.round(staleSec / 3_600));
  const shown = stale.slice(0, 5);
  const list = shown.map((s) => `• ${s.planSlug}${s.title ? ` — ${s.title}` : ''}`).join('\n');
  const more = stale.length > shown.length ? `\n…and ${stale.length - shown.length} more.` : '';
  await wakeRecipients([queenOwner], {
    summary:
      `Scout-draft review backstop: ${stale.length} scout-routed draft(s) unreviewed > ${hours}h (the ` +
      `plan-review idle activity never ran — the hive has been saturated, so the Queen was never idle). ` +
      `This is a backstop WAKE, not an idle activity: review each and either promote it (= ready), coord:send ` +
      `feedback to its scout owner to iterate, or deprecate it WITH learnings (never just leave it). Clearing ` +
      `or progressing them stops this wake.\n\n${list}${more}`,
    payload: { kind: 'scout-draft-review', slugs: stale.map((s) => s.planSlug), staleHours: hours },
    source: 'scout-draft-review',
    workspaceId,
  });
}

/**
 * The scout-draft review backstop sweep. For each STARTED hive: find scout-routed drafts
 * unreviewed past the deadline, and (debounced per-hive) wake the live Queen to review
 * them. Never throws — a watchdog that crashes its host guards nothing. DEFAULT-SAFE: no
 * stale draft ⇒ no wake. Kill switch: PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC <= 0.
 */
export async function scoutDraftReviewSweep(opts: { now?: number } = {}): Promise<ScoutDraftReviewResult[]> {
  const results: ScoutDraftReviewResult[] = [];
  const staleSec = scoutDraftReviewStaleSec();
  if (staleSec <= 0) return results; // kill switch
  try {
    const started = await listStartedHives();
    if (started.length === 0) return results;
    const { sql } = getOrgPg();
    const now = opts.now ?? Date.now();
    const thresholdMs = staleSec * 1_000;
    const windowHours = Math.max(1, Math.round(staleSec / 3_600));
    for (const { workspaceId, installSlug } of started) {
      try {
        const candidates = await readScoutDraftCandidates(sql, workspaceId, installSlug);
        const stale = selectStaleDrafts(candidates, { now, thresholdMs });
        if (stale.length === 0) continue;
        const alreadyFiredRecently =
          (await recentWatchdogFires(workspaceId, installSlug, windowHours, 'scout-draft-review')) > 0;
        if (!shouldNudgeHive({ staleCount: stale.length, alreadyFiredRecently })) {
          results.push({ workspaceId, installSlug, outcome: 'skipped', staleCount: stale.length, reason: 'debounced' });
          continue;
        }
        const queenOwner = await resolveQueenOwner(sql, workspaceId, installSlug);
        if (!queenOwner) {
          results.push({
            workspaceId,
            installSlug,
            outcome: 'skipped',
            staleCount: stale.length,
            reason: 'no live Queen session to wake',
          });
          continue;
        }
        const reason =
          `${stale.length} scout-routed draft(s) unreviewed > ${windowHours}h: ` +
          stale.slice(0, 5).map((s) => s.planSlug).join(', ');
        await fireReviewWake(workspaceId, queenOwner, stale, staleSec);
        // Record the fire so the debounce engages next tick (source='scout-draft-review').
        await recordFire({ workspaceId, installSlug, source: 'scout-draft-review', reason, wakeAt: null });
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
    console.warn(`[scout-draft-review] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
