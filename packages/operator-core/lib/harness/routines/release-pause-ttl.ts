/**
 * Pause TTL + auto-resume for RELEASE-GROUP routines, and the standing
 * "GATE PAUSED" banner every gate status surface renders while one is held.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────
 * `routines:set { active:false }` has required a `reason` since
 * EI-18654017982759582, and `routines:list` surfaces `{ reason, by, at }` since
 * EI-19336000265007219. So a deliberate pause is ATTRIBUTED. It is still
 * UNBOUNDED, and nothing announces it on the surfaces a responder actually reads
 * during an incident.
 *
 * Measured (11-day red-gate audit, 2026-08-31): the green-checkpoint routine was
 * deliberately paused for 99 hours across 14 windows — 37% of the streak —
 * including single windows of 42h17m and 21h44m. No TTL, no auto-resume, and no
 * mention of the hold in the watchdog messages, so "the gate is OFF" was
 * indistinguishable from "the gate is FAILING" to everyone reading them. Both
 * halves of that are this module:
 *
 *   1. every release-group pause carries a FINITE expiry (default
 *      {@link DEFAULT_RELEASE_PAUSE_TTL_HOURS}h, overridable per-pause), and
 *      {@link sweepExpiredReleasePauses} — one step on the existing routines
 *      engine tick — auto-resumes it and records a notice when it lapses;
 *   2. {@link gatePausedBanner} is the ONE rendering of that hold, folded into
 *      the gate status surfaces so a paused gate can never read as a merely-red
 *      one.
 *
 * ── BACK-COMPAT (the rule, stated once) ────────────────────────────────────────
 * A pause row written before this module has no `expiresAtMs`. For a
 * RELEASE-GROUP routine such a legacy pause is treated as expiring at
 * `pausedAtMs + DEFAULT_RELEASE_PAUSE_TTL_MS` — i.e. exactly as if the default
 * TTL had been stamped when it was taken. That is the simpler of the two
 * candidate rules (the other being "N hours after this code deploys", which needs
 * a deploy-time baseline nothing durable records) and it is the safe one: a
 * legacy pause is by construction OLD, so it resumes on the first sweep instead
 * of buying itself another TTL window. A legacy pause with NO parseable
 * `pausedAtMs` is UNDATABLE and is never auto-resumed — it is reported, loudly,
 * as having no scheduled auto-resume, because inventing a start time for it
 * would be inventing the very evidence its absence is the problem.
 *
 * ── THE ONE EXCLUSION ──────────────────────────────────────────────────────────
 * The structured D-012/D-013 quiescence hold (`CHECKPOINT_QUIESCENCE_PAUSE_MARKER`)
 * is NOT TTL'd and NOT swept here. It already has a purpose-built recovery path
 * that is strictly better than a timer — `decidePausedGreenCheckpointRecovery` in
 * release/green-stall-watchdog.ts re-arms it the moment its serializer owner goes
 * non-live, and deliberately leaves it alone while that owner is live. Expiring it
 * on a clock would race the release serializer it exists to protect. Because it is
 * excluded from stamping too, its banner honestly reports "no scheduled
 * auto-resume" rather than promising one that will not come.
 *
 * Scheduling: this adds NO new mechanism. It is a bounded sweep on the existing
 * durable `routinesTick` (repo rule: no bare setInterval, no third scheduler).
 */
import type { Sql } from 'postgres';
import { CHECKPOINT_QUIESCENCE_PAUSE_MARKER } from '../../release/checkpoint-serializer-authority';

/** The routine group whose pauses are release-critical and therefore always finite. */
export const RELEASE_ROUTINE_GROUP = 'release';

/**
 * Default lifetime of a release-group pause. Four hours: long enough to cover the
 * delicate manual operations these pauses exist for (a deploy-checkout surgery, a
 * frozen-candidate repair, a coordinated host restart — all measured in tens of
 * minutes), and short enough that the 21h and 42h windows the audit found cannot
 * recur silently. A caller who genuinely needs longer passes `pauseTtlHours`; the
 * point is not that four hours is right for every hold, it is that SOME finite
 * number is always recorded.
 */
export const DEFAULT_RELEASE_PAUSE_TTL_HOURS = 4;
export const DEFAULT_RELEASE_PAUSE_TTL_MS = DEFAULT_RELEASE_PAUSE_TTL_HOURS * 3_600_000;

/** Rows scanned per sweep pass. The release group holds ~12 rows; the cap is a blast-radius bound, not a page size. */
const SWEEP_ROW_CAP = 200;

/** The deliberate-pause record as persisted at `routines.metadata.pause`. */
export interface RoutinePauseRecord {
  /** True when `metadata.pause` was present at all (even if every field was empty). */
  present: boolean;
  reason: string | null;
  pausedBy: string | null;
  pausedAtMs: number | null;
  /** The stamped finite expiry, when the writer recorded one. */
  expiresAtMs: number | null;
  /** True when the record predates TTL stamping (present, but no `expiresAtMs`). */
  legacy: boolean;
}

const EMPTY_PAUSE: RoutinePauseRecord = {
  present: false,
  reason: null,
  pausedBy: null,
  pausedAtMs: null,
  expiresAtMs: null,
  legacy: false,
};

const finiteMs = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Parse `routines.metadata.pause` without trusting its shape. Accepts the same
 * field aliases the paused-gate watchdog already tolerates, so one legacy row does
 * not read as two different pauses depending on which reader looked at it.
 */
export function readRoutinePause(value: unknown): RoutinePauseRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_PAUSE;
  const rec = value as Record<string, unknown>;
  const expiresAtMs = finiteMs(rec.expiresAtMs ?? rec.pauseExpiresAtMs);
  return {
    present: true,
    reason: str(rec.reason ?? rec.pauseReason),
    pausedBy: str(rec.pausedBy ?? rec.by ?? rec.owner),
    pausedAtMs: finiteMs(rec.pausedAtMs ?? rec.pausedAt ?? rec.atMs ?? rec.at),
    expiresAtMs,
    legacy: expiresAtMs == null,
  };
}

/** Is this the structured D-012/D-013 serializer quiescence hold (see the module header's ONE EXCLUSION)? */
export function isCheckpointQuiescencePause(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(CHECKPOINT_QUIESCENCE_PAUSE_MARKER);
}

/** Does this routine belong to the group whose pauses must always be finite? */
export function isReleaseGroup(groupSlug: string | null | undefined): boolean {
  return groupSlug === RELEASE_ROUTINE_GROUP;
}

/**
 * WRITE side: the `expiresAtMs` to stamp when a pause is taken, or null when this
 * pause is not TTL-governed (not release-group, or the excluded quiescence hold).
 *
 * `ttlHours` must be finite and positive; anything else falls back to the default
 * rather than producing an infinite hold — for a release-group routine "always
 * finite" is the invariant, so a malformed override must not be able to defeat it.
 */
export function resolvePauseExpiryMs(opts: {
  groupSlug: string | null | undefined;
  pausedAtMs: number;
  ttlHours?: number | null;
  reason?: string | null;
}): number | null {
  if (!isReleaseGroup(opts.groupSlug)) return null;
  if (isCheckpointQuiescencePause(opts.reason ?? null)) return null;
  const hours =
    typeof opts.ttlHours === 'number' && Number.isFinite(opts.ttlHours) && opts.ttlHours > 0
      ? opts.ttlHours
      : DEFAULT_RELEASE_PAUSE_TTL_HOURS;
  return Math.round(opts.pausedAtMs + hours * 3_600_000);
}

/**
 * READ/ENFORCE side: when this pause lapses, applying the legacy rule from the
 * module header. Null means "no auto-resume is scheduled" — and callers must
 * render that as the absence it is, never as "not yet".
 */
export function effectivePauseExpiryMs(
  pause: RoutinePauseRecord,
  opts: { groupSlug?: string | null } = {},
): number | null {
  if (!pause.present) return null;
  if (pause.expiresAtMs != null) return pause.expiresAtMs;
  if (!isReleaseGroup(opts.groupSlug)) return null;
  if (isCheckpointQuiescencePause(pause.reason)) return null;
  if (pause.pausedAtMs == null) return null; // undatable legacy pause — see the module header
  return pause.pausedAtMs + DEFAULT_RELEASE_PAUSE_TTL_MS;
}

export type ReleasePauseExpiryVerdict =
  | {
      expired: false;
      reason: 'not-paused' | 'not-release-group' | 'serializer-quiescence-hold' | 'undatable' | 'not-yet';
      expiresAtMs: number | null;
    }
  | { expired: true; expiresAtMs: number; overdueMs: number; legacy: boolean };

/** PURE: has this release-group pause outlived its (explicit or legacy-default) TTL? */
export function classifyReleasePauseExpiry(
  input: { active: boolean | null; groupSlug: string | null; pause: RoutinePauseRecord },
  nowMs: number,
): ReleasePauseExpiryVerdict {
  if (input.active !== false || !input.pause.present) return { expired: false, reason: 'not-paused', expiresAtMs: null };
  if (!isReleaseGroup(input.groupSlug)) return { expired: false, reason: 'not-release-group', expiresAtMs: null };
  if (isCheckpointQuiescencePause(input.pause.reason)) {
    return { expired: false, reason: 'serializer-quiescence-hold', expiresAtMs: null };
  }
  const expiresAtMs = effectivePauseExpiryMs(input.pause, { groupSlug: input.groupSlug });
  if (expiresAtMs == null) return { expired: false, reason: 'undatable', expiresAtMs: null };
  if (nowMs <= expiresAtMs) return { expired: false, reason: 'not-yet', expiresAtMs };
  return { expired: true, expiresAtMs, overdueMs: nowMs - expiresAtMs, legacy: input.pause.legacy };
}

const stamp = (ms: number | null): string => (ms == null ? 'unknown' : new Date(ms).toISOString());

/**
 * PURE: the standing banner every gate status surface renders while the routine is
 * held. Returns null when there is no deliberate hold, so a caller can render it
 * unconditionally and get exactly nothing on a healthy gate.
 *
 * The auto-resume clause is deliberately three-valued rather than two: a hold with
 * no scheduled auto-resume must SAY so, because "GATE PAUSED …" with the clause
 * silently omitted reads as "it will come back on its own" — which is the belief
 * that let a 42-hour window pass unremarked.
 */
export function gatePausedBanner(opts: {
  routineName: string;
  installSlug?: string | null;
  groupSlug?: string | null;
  pause: RoutinePauseRecord;
  nowMs: number;
}): string | null {
  if (!opts.pause.present) return null;
  const where = opts.installSlug ? ` on ${opts.installSlug}` : '';
  const heldMs = opts.pause.pausedAtMs != null ? Math.max(0, opts.nowMs - opts.pause.pausedAtMs) : null;
  const heldFor = heldMs != null ? ` (held ~${Math.max(1, Math.round(heldMs / 60_000))}m)` : '';
  const expiresAtMs = effectivePauseExpiryMs(opts.pause, { groupSlug: opts.groupSlug });
  const resume =
    expiresAtMs == null
      ? isCheckpointQuiescencePause(opts.pause.reason)
        ? ' — NO timed auto-resume: this is the structured D-012/D-013 serializer quiescence hold, ' +
          'which is re-armed when its serializer owner goes non-live, not on a clock.'
        : ' — ⚠ NO auto-resume is scheduled; NOTHING will re-arm it. Resume it deliberately with ' +
          `routines:set { name: "${opts.routineName}", active: true }.`
      : opts.nowMs > expiresAtMs
        ? ` — its ${opts.pause.legacy ? 'legacy-default ' : ''}TTL LAPSED at ${stamp(expiresAtMs)}; ` +
          'the routines engine auto-resumes it on the next tick.'
        : ` — auto-resumes ${stamp(expiresAtMs)}${opts.pause.legacy ? ' (legacy pause: default release TTL applied)' : ''}.`;
  return (
    `⛔ ${opts.routineName.toUpperCase()} PAUSED${where} since ${stamp(opts.pause.pausedAtMs)} ` +
    `by ${opts.pause.pausedBy ?? '(unknown)'} (${opts.pause.reason ?? 'no reason recorded'})${heldFor}${resume} ` +
    'A PAUSED gate is not a FAILING gate: no verdict is coming, so any red counters below describe an older run.'
  );
}

/** One routine this sweep re-armed. */
export interface ReleasePauseAutoResume {
  workspaceId: string;
  installSlug: string;
  name: string;
  expiresAtMs: number;
  overdueMs: number;
  legacy: boolean;
  pauseReason: string | null;
  pausedBy: string | null;
  pausedAtMs: number | null;
}

interface ReleasePauseRow {
  workspace_id: string;
  install_slug: string;
  name: string;
  active: boolean | null;
  group_slug: string | null;
  pause: unknown;
}

/**
 * One bounded sweep pass: auto-resume every release-group routine whose deliberate
 * pause has outlived its TTL, and record a notice for each.
 *
 * Fail-soft throughout — this rides the routines engine tick, so a bad row, a dead
 * notification rail or an unreadable pause must never break the tick that fires
 * git-sync. The re-arm UPDATE is guarded on the EXACT pause blob it classified
 * (jsonb equality is order-insensitive), so a pause that changed between the read
 * and the write is left for the next pass instead of being clobbered — the same
 * optimistic-concurrency idiom the serializer re-arm in green-stall-watchdog uses.
 */
export async function sweepExpiredReleasePauses(
  sql: Sql,
  opts: { nowMs?: number; limit?: number; notify?: boolean } = {},
): Promise<ReleasePauseAutoResume[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? SWEEP_ROW_CAP;
  const resumed: ReleasePauseAutoResume[] = [];

  let rows: ReleasePauseRow[];
  try {
    rows = await sql<ReleasePauseRow[]>`
      SELECT workspace_id, install_slug, name, active, group_slug, metadata->'pause' AS pause
        FROM harness_shared.routines
       WHERE group_slug = ${RELEASE_ROUTINE_GROUP}
         AND active = false
         AND metadata ? 'pause'
       LIMIT ${limit}`;
  } catch (e) {
    console.warn(`[release-pause-ttl] scan failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return resumed;
  }

  for (const row of rows) {
    const pause = readRoutinePause(row.pause);
    const verdict = classifyReleasePauseExpiry(
      { active: row.active, groupSlug: row.group_slug, pause },
      nowMs,
    );
    if (!verdict.expired) continue;

    try {
      const lastPause = {
        ...((row.pause as Record<string, unknown> | null) ?? {}),
        resumedAtMs: nowMs,
        autoResumedAtMs: nowMs,
        autoResumedBy: 'release-pause-ttl',
        autoResumeReason: verdict.legacy ? 'legacy-pause-default-ttl-lapsed' : 'pause-ttl-lapsed',
        expiresAtMs: verdict.expiresAtMs,
      };
      const updated = await sql<{ install_slug: string }[]>`
        UPDATE harness_shared.routines r
           SET active = true,
               next_fire_at = now(),
               metadata = jsonb_set(
                 COALESCE(r.metadata, '{}'::jsonb) - 'pause',
                 '{lastPause}',
                 ${JSON.stringify(lastPause)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE r.workspace_id = ${row.workspace_id}
           AND r.install_slug = ${row.install_slug}
           AND r.name = ${row.name}
           AND r.group_slug = ${RELEASE_ROUTINE_GROUP}
           AND r.active = false
           AND r.metadata->'pause' = ${JSON.stringify(row.pause)}::text::jsonb
        RETURNING r.install_slug`;
      if (!updated[0]) continue; // raced — the next pass classifies the new state

      const record: ReleasePauseAutoResume = {
        workspaceId: row.workspace_id,
        installSlug: row.install_slug,
        name: row.name,
        expiresAtMs: verdict.expiresAtMs,
        overdueMs: verdict.overdueMs,
        legacy: verdict.legacy,
        pauseReason: pause.reason,
        pausedBy: pause.pausedBy,
        pausedAtMs: pause.pausedAtMs,
      };
      resumed.push(record);
      console.warn(
        `[release-pause-ttl] AUTO-RESUMED ${row.install_slug}/${row.name} — pause by ${pause.pausedBy ?? '(unknown)'} ` +
          `("${pause.reason ?? 'no reason recorded'}") lapsed at ${stamp(verdict.expiresAtMs)} ` +
          `(${Math.round(verdict.overdueMs / 60_000)}m overdue${verdict.legacy ? ', legacy pause / default TTL' : ''})`,
      );

      if (opts.notify !== false) await notifyAutoResume(record);
    } catch (e) {
      console.warn(
        `[release-pause-ttl] auto-resume failed for ${row.install_slug}/${row.name} (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return resumed;
}

/**
 * The notice. Same primitive every other routine-lifecycle event here uses
 * (`notifyAttention*` from attention-notify) — deliberately NOT a new channel.
 * `notifyAttentionOnce` because a DBOS step retry must not deliver twice; the key
 * is the lapsed expiry, so a LATER pause on the same routine notifies again.
 */
async function notifyAutoResume(record: ReleasePauseAutoResume): Promise<void> {
  try {
    const { notifyAttentionOnce } = await import('../../attention-notify');
    await notifyAttentionOnce({
      kind: 'intervention',
      importance: 'high',
      harnessSlug: record.installSlug,
      workspaceId: record.workspaceId,
      title: `Release routine AUTO-RESUMED — "${record.name}" pause TTL lapsed`,
      body:
        `"${record.name}" (${record.installSlug}) is in the release group, so its deliberate pause carries a finite TTL. ` +
        `That TTL lapsed at ${stamp(record.expiresAtMs)} (${Math.round(record.overdueMs / 60_000)}m overdue)` +
        `${record.legacy ? ' — this pause predates TTL stamping, so the default release TTL was applied to it' : ''}, ` +
        `and the routines engine has re-armed the routine. The hold was taken by ${record.pausedBy ?? '(unknown)'} ` +
        `at ${stamp(record.pausedAtMs)}: "${record.pauseReason ?? 'no reason recorded'}". ` +
        'If the hold is still needed, re-pause it with an explicit `pauseTtlHours` rather than leaving it open-ended.',
      dedupeKey: `release-pause-ttl:${record.installSlug}:${record.name}:${record.expiresAtMs}`,
      data: {
        routine: record.name,
        installSlug: record.installSlug,
        event: 'release-pause-ttl-auto-resume',
        expiresAtMs: record.expiresAtMs,
        overdueMs: record.overdueMs,
        legacyPause: record.legacy,
        pausedBy: record.pausedBy,
        pauseReason: record.pauseReason,
      },
    });
  } catch (e) {
    console.warn(`[release-pause-ttl] auto-resume notice failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  try {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    notifySyncInvalidate('automation.catalog');
  } catch {
    /* SSE hub unavailable — the automation pane refreshes on its next read */
  }
}
