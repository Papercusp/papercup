/**
 * unservable-critical-watchdog (EI-19919820196426791 half 2) — alarm on an issue
 * that is simultaneously the HIGHEST-severity thing in the system and invisible
 * to every claim path.
 *
 * THE CLASS THIS ANSWERS. An item in `lane='observation'` or `state='needs-human'`
 * is structurally unclaimable: the observation lane never enters the work queue by
 * design, and a non-`open` state is not claimable. That is correct behaviour. What
 * is NOT correct is that a `critical` item can sit in one of those lanes forever
 * with nothing anywhere reporting the contradiction. The filed instance: cup:spawn
 * was 100% broken for 19 days while BOTH records of it sat in unservable lanes, and
 * three Mug incarnations re-placed cups that died in seconds because severity and
 * feature_order — the only steering levers — cannot move an item out of a lane the
 * claim layer does not serve.
 *
 * WHY THE WRITE-TIME GUARD IS NOT ENOUGH (this file's whole reason to exist).
 * `work_items:set_priority` and `work_items:update` already return a
 * `claimabilityWarning` when someone raises priority/severity on such a row
 * (structuralClaimabilityWarning, driven by the same `explainIssueClaimFloors`
 * oracle the real claim path uses). That closes the STEERING case — you are told at
 * the moment your steer is a no-op. It cannot close the case that actually caused
 * the 19-day hide: the original item was FILED into the observation lane as a nit
 * and NOBODY EVER WROTE TO IT AGAIN. No write, no warning. A guard that only fires
 * on a write cannot see an item nobody touches, so the residual hole is exactly the
 * never-touched mis-file — and only a periodic sweep closes it.
 *
 * CRITICAL-ONLY, AND THAT THRESHOLD IS MEASURED, NOT GUESSED. The filed proposal
 * said "severity critical/major and an age over N days". Measured against the live
 * backlog before building (2026-08-19, harness papercusp, non-terminal):
 *
 *     needs-human   critical     6   (4 older than 7d)
 *     needs-human   major       41  (38 older than 7d)
 *     observation   critical     4   (1 older than 7d)
 *     observation   major      118  (14 older than 7d)
 *
 * Including `major` makes this fire 57 times on its first tick. An alarm that opens
 * 57 escalations is a backlog listing, and the next one is ignored — which is the
 * failure mode this watchdog exists to prevent, re-created by the watchdog itself.
 * `critical` alone yields 5. So the severity set is deliberately NOT the filed one;
 * widening it is a decision to be made against a fresh measurement, not a tweak.
 *
 * Shape follows the watchdog family (carry-drill-drop, goal-liveness):
 *  - `managedSetInterval`, never a bare setInterval, so it is visible in
 *    `schedule:inventory`.
 *  - Runtime gate FLAGS.UNSERVABLE_CRITICAL_WATCHDOG (default ON), per tick.
 *  - Dedup delegated to openEscalation's (dedupKind, subjectSignature) PG dedup,
 *    keyed on the item id — one open escalation per stranded item, no new state.
 *  - The classifier is a PURE function over rows so its thresholds are testable
 *    without a database.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export const UNSERVABLE_CRITICAL_SWEEP_INTERVAL_MS = 30 * 60_000;

/** How long a critical item may sit in an unservable lane before it is reported.
 *  Long enough that a deliberate short park (triage in progress, a mis-file being
 *  corrected) never alarms; short enough that nothing repeats the 19-day hide. */
export const UNSERVABLE_CRITICAL_MIN_AGE_MS = 7 * 24 * 60 * 60_000;

/** Severities this watchdog reports. See the header: `major` is EXCLUDED on
 *  measurement, not on taste — it turns 5 alerts into 57. */
export const UNSERVABLE_REPORTED_SEVERITIES: readonly string[] = ['critical'];

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'unservable-critical-watchdog',
  ownerLabel: 'system · unservable critical items',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Which structural floor makes the row unclaimable. Named for the floor the
 *  claim oracle itself reports, so the escalation's remedy matches what
 *  `work_items:claimable`'s `excludedBreakdown` calls the same bucket. */
export type UnservableFloor = 'observation-lane' | 'needs-human';

export interface UnservableItemRow {
  itemId: string;
  workspaceId: string;
  harnessSlug: string;
  title: string;
  severity: string;
  floor: UnservableFloor;
  createdAtMs: number;
}

export interface UnservableAlert {
  itemId: string;
  workspaceId: string;
  harnessSlug: string;
  title: string;
  severity: string;
  floor: UnservableFloor;
  ageMs: number;
}

/**
 * Pure classifier: which rows are stranded-critical right now.
 *
 * Exported and dependency-free so the two thresholds that decide this
 * watchdog's entire alert volume — the severity set and the age floor — can be
 * tested directly. A row is reported only when BOTH hold; either alone is
 * ordinary and must stay silent.
 */
export function scanUnservableCritical(
  rows: readonly UnservableItemRow[],
  nowMs: number,
  opts: { minAgeMs?: number; severities?: readonly string[] } = {},
): UnservableAlert[] {
  const minAgeMs = opts.minAgeMs ?? UNSERVABLE_CRITICAL_MIN_AGE_MS;
  const severities = opts.severities ?? UNSERVABLE_REPORTED_SEVERITIES;
  const alerts: UnservableAlert[] = [];
  for (const row of rows) {
    if (!severities.includes(row.severity)) continue;
    const ageMs = nowMs - row.createdAtMs;
    if (ageMs < minAgeMs) continue;
    alerts.push({
      itemId: row.itemId,
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug,
      title: row.title,
      severity: row.severity,
      floor: row.floor,
      ageMs,
    });
  }
  // Oldest first: the longest-stranded item is the one most likely to be a real
  // hidden blocker rather than an in-flight triage.
  return alerts.sort((a, b) => b.ageMs - a.ageMs);
}

export interface UnservableSweepDeps {
  readRows: () => Promise<UnservableItemRow[]>;
  escalate: (alert: UnservableAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.UNSERVABLE_CRITICAL_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

/**
 * ⚠ Reads the `harness_shared.engineer_issues` VIEW, not the underlying
 * `work_items` TABLE, and that is load-bearing: severity is a real column on the
 * view, while on the table it lives at `payload->'_ei'->>'severity'`. The view
 * SUBTRACTS the `_ei` blob after exploding it into columns, so the payload path
 * resolves to NULL for every row there — a silent wrong answer, not an error
 * (P-018 / WI-6674). Query the view, read the column.
 */
function makeReadRows(sql: Sql): UnservableSweepDeps['readRows'] {
  return async () => {
    const rows = await sql<
      {
        issue_id: string;
        workspace_id: string;
        harness_slug: string | null;
        title: string | null;
        severity: string;
        floor: string;
        created_ms: string;
      }[]
    >`
      SELECT issue_id,
             workspace_id,
             replace(scope, 'harness:', '') AS harness_slug,
             title,
             severity,
             CASE WHEN lane = 'observation' THEN 'observation-lane' ELSE 'needs-human' END AS floor,
             (extract(epoch FROM created_at) * 1000)::bigint AS created_ms
        FROM harness_shared.engineer_issues
       WHERE state NOT IN ('done', 'passed', 'resolved', 'closed', 'deprecated', 'dropped')
         AND (lane = 'observation' OR state = 'needs-human')
         AND severity = ANY (${UNSERVABLE_REPORTED_SEVERITIES as string[]})`;
    return rows.map((r) => ({
      itemId: r.issue_id,
      workspaceId: r.workspace_id,
      harnessSlug: r.harness_slug ?? 'unknown',
      title: r.title ?? '(untitled)',
      severity: r.severity,
      floor: r.floor === 'observation-lane' ? 'observation-lane' : 'needs-human',
      createdAtMs: Number(r.created_ms),
    }));
  };
}

function describeDays(ageMs: number): string {
  return `${Math.floor(ageMs / (24 * 60 * 60_000))}d`;
}

async function defaultEscalate(alert: UnservableAlert): Promise<void> {
  const remedy =
    alert.floor === 'needs-human'
      ? `work_items:update { id: '${alert.itemId}', needsHuman: false } if it should actually be worked`
      : `re-file/relocate it out of the observation lane (it was captured via improvements:capture { lane:'observation' }, which by design never enters the work queue)`;
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${alert.severity.toUpperCase()} item ${alert.itemId} has been structurally UNCLAIMABLE for ${describeDays(alert.ageMs)} ` +
      `(${alert.floor}) — no claim path can serve it`,
    body:
      `${alert.itemId} (${alert.harnessSlug}) is severity ${alert.severity} and has sat in the ` +
      `${alert.floor} floor for ${describeDays(alert.ageMs)}: "${alert.title}"\n\n` +
      `Those two facts are in conflict and nothing else reports it. The item is invisible to ` +
      `scheduler:get_next, work_items:claim_next and work_items:claimable, so raising its severity ` +
      `or setting a feature_order does NOT make it workable — those writes report ok:true and change ` +
      `nothing about claimability.\n\n` +
      `This is either a MIS-FILE (severity or lane is wrong) or a GENUINELY STRANDED BLOCKER. Both ` +
      `want a human or a Mug to look. It is filed as advisory rather than actioned automatically ` +
      `because deciding which of those two it is requires reading the item.\n\n` +
      `Remedy: ${remedy}.\n\n` +
      `Why a periodic sweep and not the write-time guard: set_priority/update already warn when ` +
      `SOMEONE WRITES to such a row, but the filed instance (EI-19919820196426791) was an item ` +
      `nobody ever wrote to after filing it — cup:spawn was 100% broken for 19 days behind exactly ` +
      `this shape.`,
    meta: {
      dedupKind: 'unservable-critical',
      subjectSignature: alert.itemId,
      itemId: alert.itemId,
      itemWorkspaceId: alert.workspaceId,
      harnessSlug: alert.harnessSlug,
      floor: alert.floor,
      severity: alert.severity,
      ageMs: alert.ageMs,
    },
  });
}

function sweepDeps(sql: Sql, overrides: Partial<UnservableSweepDeps>): UnservableSweepDeps {
  return {
    readRows: makeReadRows(sql),
    escalate: defaultEscalate,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    ...overrides,
  };
}

/**
 * One sweep: find stranded-critical items and escalate each. Exported for tests.
 *
 * A failed escalate does NOT abort the batch — unlike the carry-drill sibling,
 * there is no watermark to protect here (the query is a full current-state read,
 * not an incremental ledger tail), so the right behaviour is to report the rest
 * and let the next tick retry the failure. The (dedupKind, subjectSignature)
 * dedup makes that retry idempotent.
 */
export async function runUnservableCriticalSweepOnce(
  sql: Sql,
  overrides: Partial<UnservableSweepDeps> = {},
): Promise<{ scanned: number; escalated: number; failed: number; skipped: boolean }> {
  const deps = sweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return { scanned: 0, escalated: 0, failed: 0, skipped: true };
  }
  const rows = await deps.readRows();
  const alerts = scanUnservableCritical(rows, deps.now());
  let escalated = 0;
  let failed = 0;
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch (e) {
      failed += 1;
      console.warn(
        `[unservable-critical-watchdog] escalate failed for ${alert.itemId} (retried next tick): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return { scanned: rows.length, escalated, failed, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the unservable-critical watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.UNSERVABLE_CRITICAL_WATCHDOG (checked per tick).
 */
export function startUnservableCriticalWatchdog(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  const intervalMs = opts.intervalMs ?? UNSERVABLE_CRITICAL_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'unservable-critical-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runUnservableCriticalSweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[unservable-critical-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // The trigger is ELAPSED TIME with no state change — an item going quiet in an
    // unservable lane emits nothing, and absence-over-a-deadline has no publisher
    // to subscribe to.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
