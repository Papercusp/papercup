/**
 * hive-canary-action.ts — the daily hive-loop canary
 * (hive-loop-e2e-testing-2026-06-10 P-009, Tier 3).
 *
 * The live complement to the hermetic tiers: once a day, queue ONE trivial
 * feature into a dedicated throwaway canary harness and touch nothing — the
 * autonomous loop (routine tick → blueprint-run → dispatch → pipeline) must
 * carry it to a terminal state on its own. The NEXT day's tick checks the
 * previous canaries: one still un-terminal past its deadline means the
 * production loop is broken in a way the hermetic tiers can't see (config rot,
 * budget exhaustion, prompt drift — plan D-001), and files a forensics-laden
 * improvement (DBOS workflow status + nursery rows + fire-state attached)
 * through the watchdog's capture core (tagged + deduped — plan D-006).
 *
 * One `system:hive-canary` action, two phases per fire, both replay-safe:
 *   1. CHECK — canary features (payload.canary=true) older than
 *      `deadlineHours` (default 6) that are not terminal and not yet reported
 *      → gather forensics → captureImprovement (kind=bug, dedupScope 'open')
 *      → stamp payload.canary_reported so a fixed loop doesn't re-file daily.
 *   2. QUEUE — insert today's `F-CANARY-<YYYYMMDD>` (ON CONFLICT DO NOTHING —
 *      idempotent across replays and same-day re-fires).
 *
 * SELF-GATING: when the routine's harness is not in the workspace registry the
 * fire logs + no-ops cleanly (no error, no backoff) — so the routine can stay
 * ACTIVE and becomes effective the moment a canary harness is registered.
 * Cost: one trivial feature per day (plan D-004).
 *
 * EI-7655: Phase 2's INSERT is raw SQL (idempotent, replay-safe), NOT
 * work_items:create — so it never fired that tool's `emits` demand event, the
 * signal the Queen's default wake subscription rides (start-hive-wake-
 * orchestration-2026-06-09 P-001/D-001, see work_items/create.ts). A freshly
 * queued canary was therefore invisible to the event-driven wake path and sat
 * silent until some UNRELATED demand in the same Hive happened to wake the
 * Queen anyway (usually true for a busy Hive — hence "usually passes" — but
 * not guaranteed, and the exact "DBOS pipelines: NONE / no autoloop_state
 * rows" forensics a missed canary reports). Fixed by calling the same
 * `requestUrgentHiveWake` bypass `work_items:create`'s `urgent` flag uses,
 * right after a NEW canary is actually inserted — mirrors the existing
 * hive-home resolution used a few lines below for the pause check.
 *
 * Seed: seed-hive-canary-routine.ts. Registered via register-system-actions.
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { loadHarnessRegistry } from '../../harness-registry';
import { captureImprovement } from '../improvements/capture-core';
import { getOwnerSteering, isPausedNow } from '../../owner-steering';
import { requestUrgentHiveWake } from '../../hive/urgent-wake';

/** Terminal-enough statuses: the loop carried the canary to a verdict. */
const CANARY_TERMINAL = new Set(['passed', 'deprecated', 'failed']);

export interface CanaryFeatureRow {
  feature_id: string;
  status: string;
  created_ts: number | string;
  payload: { canary?: boolean; canary_reported?: boolean } | null;
}

export interface CanaryPlan {
  /** Canary ids overdue (past deadline, non-terminal, unreported) — to report. */
  overdue: string[];
  /** Today's canary feature id (`F-CANARY-<YYYYMMDD>`). */
  queueId: string;
  /**
   * Canary ids that WOULD be overdue but are suppressed because the harness's
   * Hive currently has `pauseNewWork` set (owner-steering-pause-aware-canary
   * follow-on to EI-7420) — an intentional pause is not an autonomous-loop
   * failure. NOT marked canary_reported, so a still-non-terminal canary is
   * re-evaluated (and genuinely reported if still overdue) once un-paused.
   */
  suppressed: string[];
}

/** Today's canary id from a clock (UTC date-keyed — one per day, replay-stable). */
export function canaryIdFor(nowMs: number): string {
  const d = new Date(nowMs);
  const ymd =
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
  return `F-CANARY-${ymd}`;
}

/**
 * Pure tick planning: which existing canaries are overdue (created more than
 * `deadlineHours` ago, not terminal, not already reported), and today's queue id.
 */
export function planCanaryTick(
  rows: CanaryFeatureRow[],
  opts: { deadlineHours?: number; nowMs?: number; isPaused?: boolean } = {},
): CanaryPlan {
  const deadlineHours = opts.deadlineHours ?? 6;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - deadlineHours * 3_600_000;
  const candidates = rows
    .filter((r) => r.payload !== null && r.payload !== undefined)
    .filter((r) => r.payload.canary === true)
    .filter((r) => r.payload.canary_reported !== true)
    .filter((r) => !CANARY_TERMINAL.has(r.status))
    .filter((r) => Number(r.created_ts) < cutoff)
    .map((r) => r.feature_id);
  // Pause-aware (EI-7420): an owner-initiated pauseNewWork means the Queen is
  // intentionally starting no new work — a stuck canary under that condition is
  // an expected consequence of the pause, not a broken autonomous loop. Suppress
  // the report entirely (never mark canary_reported) so the SAME canary is
  // re-evaluated — and genuinely reported if still overdue — once un-paused.
  if (opts.isPaused) {
    return { overdue: [], queueId: canaryIdFor(nowMs), suppressed: candidates };
  }
  return { overdue: candidates, queueId: canaryIdFor(nowMs), suppressed: [] };
}

/** Forensics for one missed canary: DBOS pipeline rows + nursery rows + fire-state. */
async function gatherForensics(slug: string, featureId: string, workspaceId: string): Promise<string> {
  const { sql } = getOrgPg();
  const parts: string[] = [];
  try {
    const reg = await sql<{ t: string | null }[]>`SELECT to_regclass('dbos.workflow_status') AS t`;
    if (reg[0]?.t) {
      const wfs = await sql<{ workflow_uuid: string; status: string; created_at: string | null }[]>`
        SELECT workflow_uuid, status, to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD HH24:MI') AS created_at
          FROM dbos.workflow_status
         WHERE workflow_uuid LIKE ${'pipeline:' + slug + ':' + featureId + ':%'}
         ORDER BY workflow_uuid`;
      parts.push(
        wfs.length
          ? `DBOS pipelines: ${wfs.map((w) => `${w.workflow_uuid}=${w.status} (${w.created_at ?? '?'})`).join('; ')}`
          : 'DBOS pipelines: NONE — the dispatcher never started a pipeline for this canary (links 1–3 broken).',
      );
    } else {
      parts.push('DBOS pipelines: dbos schema absent (DBOS not booted on this host).');
    }
  } catch (e) {
    parts.push(`DBOS pipelines: read failed (${e instanceof Error ? e.message : e})`);
  }
  try {
    const spawns = await sql<{ spawn_id: string; child_role: string; status: string; error_message: string | null }[]>`
      SELECT spawn_id, child_role, status, error_message
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug} AND feature_id = ${featureId}
       ORDER BY started_at DESC LIMIT 10`;
    parts.push(
      spawns.length
        ? `Nursery: ${spawns.map((s) => `${s.spawn_id} ${s.child_role}=${s.status}${s.error_message ? ` (${s.error_message.slice(0, 120)})` : ''}`).join('; ')}`
        : 'Nursery: no agent spawns recorded for this canary.',
    );
  } catch (e) {
    parts.push(`Nursery: read failed (${e instanceof Error ? e.message : e})`);
  }
  try {
    const fires = await sql<{ role: string; last_status: string | null; consecutive_errors: number }[]>`
      SELECT role, last_status, consecutive_errors::int
        FROM harness_shared.autoloop_state
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug}
       ORDER BY role`;
    parts.push(
      fires.length
        ? `Fire-state: ${fires.map((f) => `${f.role}: ${f.last_status ?? '(none)'} (consecutive_errors=${f.consecutive_errors})`).join('; ')}`
        : 'Fire-state: no autoloop_state rows — the trigger chain (link 1) never fired for this harness.',
    );
  } catch (e) {
    parts.push(`Fire-state: read failed (${e instanceof Error ? e.message : e})`);
  }
  return parts.join('\n');
}

registerSystemAction('hive-canary', async (ctx: SystemActionCtx) => {
  const { installSlug, workspaceId, payloadTemplate } = ctx;
  const deadlineHours = Number(payloadTemplate?.deadlineHours) || 6;

  // Self-gate: no registered canary harness → clean no-op (the routine stays
  // ACTIVE; it goes live the moment the harness is registered).
  try {
    const reg = await loadHarnessRegistry(workspaceId);
    if (!reg.projects.some((p) => p.slug === installSlug)) {
      console.log(`[hive-canary] harness "${installSlug}" not registered in ${workspaceId} — skipping (self-gate)`);
      return;
    }
  } catch (e) {
    console.warn(`[hive-canary] registry unreadable — skipping: ${e instanceof Error ? e.message : e}`);
    return;
  }

  const { sql } = getOrgPg();
  const rows = await sql<CanaryFeatureRow[]>`
    SELECT feature_id, status, created_ts, payload
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug}
       AND item_kind = 'feature' AND payload IS NOT NULL AND payload->>'canary' = 'true'
     ORDER BY created_ts DESC LIMIT 30`;

  // Pause-aware (EI-7420): resolve the Hive this harness belongs to (a MEMBER
  // harness carries `hive_slug`; a hive-home harness IS its own hive) and check
  // whether the owner currently has pauseNewWork set — an intentional pause, not
  // an autonomous-loop failure, so a stuck canary under it shouldn't file a bug.
  let isPaused = false;
  // EI-7655: resolved here for the pause check, reused below to wake the
  // correct Hive (a MEMBER harness's demand event must wake ITS hive home,
  // not itself) after Phase 2 queues a genuinely new canary.
  let hiveHomeSlug = installSlug;
  try {
    const reg = await loadHarnessRegistry(workspaceId);
    hiveHomeSlug = reg.projects.find((p) => p.slug === installSlug)?.hive_slug ?? installSlug;
    const steering = await getOwnerSteering(workspaceId, hiveHomeSlug, sql);
    isPaused = isPausedNow(steering, Date.now());
  } catch (e) {
    console.warn(`[hive-canary] pause-check failed for ${installSlug} — treating as unpaused: ${e instanceof Error ? e.message : e}`);
  }
  const plan = planCanaryTick(rows, { deadlineHours, isPaused });
  if (plan.suppressed.length > 0) {
    console.log(`[hive-canary] ${installSlug}: suppressed ${plan.suppressed.length} overdue report(s) — Hive is owner-paused (pauseNewWork): ${plan.suppressed.join(', ')}`);
  }

  // Phase 1 — CHECK: report each overdue canary with forensics (cap 3/tick).
  for (const fid of plan.overdue.slice(0, 3)) {
    const forensics = await gatherForensics(installSlug, fid, workspaceId);
    const res = await captureImprovement({
      title: `Hive canary ${installSlug}/${fid} missed its deadline`,
      kind: 'bug',
      severity: 'major',
      body:
        `The daily canary feature ${fid} in harness ${installSlug} did not reach a terminal state within ` +
        `${deadlineHours}h untouched — the autonomous hive loop is not carrying queued work end-to-end ` +
        `(hive-loop-e2e-testing-2026-06-10 P-009).\n\nForensics:\n${forensics}`,
      foundDuring: 'hive-canary routine',
      dedupScope: 'open',
      watchdogKey: `hive-canary:${installSlug}:${fid}`,
    });
    // Mark reported regardless of created/deduped — one report per canary.
    // Merge canary_reported: true into the payload JSONB object (or create the object if payload is null).
    const updateResult = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = CASE
               WHEN payload IS NULL THEN '{"canary": true, "canary_reported": true}'::jsonb
               ELSE payload || '{"canary_reported": true}'::jsonb
             END,
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug} AND feature_id = ${fid}
       RETURNING feature_id`;
    if (updateResult.length === 0) {
      console.warn(
        `[hive-canary] ${installSlug}/${fid} UPDATE failed — row not found in database`,
      );
    } else {
      console.warn(
        `[hive-canary] ${installSlug}/${fid} MISSED its ${deadlineHours}h deadline — ` +
          (res.created ? `filed ${res.issue?.id ?? 'improvement'}` : `report deduped (${res.reason ?? 'duplicate'})`),
      );
    }
  }

  // Phase 2 — QUEUE today's canary (idempotent: date-keyed id + DO NOTHING).
  const now = Date.now();
  const title = typeof payloadTemplate?.title === 'string' && payloadTemplate.title.trim()
    ? payloadTemplate.title.trim()
    : 'Canary: append today\'s date to CANARY.md';
  // P-006 (autonomous-loop-canary-reliability-2026-06-29): seed the canary with a
  // HIGH backlog priority (low feature_order — the claim layer orders feature_order
  // ASC NULLS LAST) so the deadline-bound health check is placed PROMPTLY even in a
  // deep frontier. Without it the canary lands feature_order=NULL and sorts behind
  // every prioritized item (observed: a 214-deep frontier left it unplaced for hours,
  // failing the deadline even though the loop was healthy). Configurable via the
  // routine payload (featureOrder); default 0 = top of the backlog.
  const canaryOrder = Number.isFinite(Number(payloadTemplate?.featureOrder))
    ? Math.trunc(Number(payloadTemplate.featureOrder))
    : 0;
  try {
    const inserted = await sql<{ feature_id: string }[]>`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, summary, status, attempts, item_kind,
         feature_order, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts)
      VALUES
        (${installSlug}, ${plan.queueId}, ${title},
         'Trivial daily canary feature — the autonomous loop must carry it to DONE untouched.',
         'todo', 0, 'feature', ${canaryOrder}, '{"canary": true}'::jsonb, FALSE, ${workspaceId}, ${now}, ${now}, ${now})
      ON CONFLICT (harness_slug, feature_id) DO NOTHING
      RETURNING feature_id`;
    if (inserted.length > 0) {
      console.log(`[hive-canary] queued ${installSlug}/${plan.queueId} (deadline ${deadlineHours}h)`);
      // EI-7655: this raw INSERT bypasses work_items:create's `emits` demand
      // event, so without an explicit wake the newly-queued canary is invisible
      // to the Queen's event-driven wake path. Mirror the `urgent` bypass
      // (fail-soft by contract — never throws, worst case is a floor-bounded
      // coalesce) so the canary is woken-for promptly instead of relying on
      // incidental unrelated Hive demand.
      try {
        const wake = await requestUrgentHiveWake({
          reason: `hive-canary: queued today's canary ${plan.queueId} in ${installSlug}`,
          harness: hiveHomeSlug,
          workspaceId,
        });
        if (wake.error) {
          console.warn(`[hive-canary] urgent wake for ${installSlug}/${plan.queueId} failed (canary still queued): ${wake.error}`);
        }
      } catch (e) {
        console.warn(`[hive-canary] urgent wake threw for ${installSlug}/${plan.queueId} (canary still queued): ${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.log(`[hive-canary] ${installSlug}/${plan.queueId} already queued from previous run`);
    }
  } catch (e) {
    console.error(`[hive-canary] failed to queue ${installSlug}/${plan.queueId}: ${e instanceof Error ? e.message : e}`);
  }
});
