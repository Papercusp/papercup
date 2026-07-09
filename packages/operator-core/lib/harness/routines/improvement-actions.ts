/**
 * Self-improvement-loop system actions (papercusp-self-improvement-loop-2026-06-04,
 * Phase 2 + Phase 3; close-the-self-improvement-loop-2026-06-05 D-001/D-003).
 * Two routines, registered here so the routines engine can fire them; both
 * SEEDED INACTIVE (seed-improvement-routines.ts). (The former `improvement-digest`
 * routine was REMOVED — operator-learning-tab-2026-06-09 D-001: its only job was
 * pushing the triage headline to the human inbox, a dead-end notification. The
 * backlog is now PULLED in the Learning tab; see the note above the watchdog.)
 *
 *   - `system:improvement-watchdog` (close-loop D-003) — the HARD feed-in: sweep
 *     the operator's own telemetry (red tests, failing smokes, repeated tool
 *     errors, down services) and auto-capture each as a kind=bug improvement via
 *     the shared capture core (search-first dedup, per-tick cap). Capture only —
 *     builds nothing.
 *
 *   - `system:improvement-implement` (Phase 3) — the AUTO-implement loop, gated by
 *     the `papercusp-improvement-auto-implement` flag (default OFF). When OFF it
 *     no-ops (just reports the waiting count). When ON it dispatches up to a cap of
 *     auto-eligible bugs (D-004) to a DEDICATED runner harness (D-006) — never
 *     in-process — which lands them via the release gate (D-008) + the
 *     release-manager (D-005). The decision is the pure `planImplementRun`; this
 *     handler is thin glue + the dispatch. Each dispatch CLAIMS the item + bumps
 *     its attempt counter, and the worker closes the loop with
 *     `improvements:resolve` (close-loop D-001) — so a fixed bug leaves the queue
 *     and nothing double-dispatches.
 *
 * Runs as ONE durable step (the system-actions contract) — safe to re-run from the
 * top: the digest is a pure read; implement claims each item BEFORE firing
 * (close-the-self-improvement-loop-2026-06-05 D-001), so a re-run sees it
 * in-flight and skips it — no double dispatch. The loop CLOSES through the
 * `improvements:resolve` back-edge the worker calls on a verified fix.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';
import { buildLaunchSpawnRequest } from '../../blueprint/launch-blueprint';
import type { DurableSpawnFireInput } from '../../dbos/durable-spawn';
import { readImprovementItems } from '../improvements/read-items';
import { planImplementRun } from '../improvements/plan-implement';
import { readAutoImplementPolicy } from '../../auto-implement-policy';
import { isShuttingDown } from '../../shutdown-state';
import { readOwnerFullAutonomyGrant } from '../improvements/full-autonomy-grant';
import { readRecentDispatches, recordDispatchFired, recordFireResult } from '../improvements/dispatch-ledger';
import { laneInEnvOutage } from '../improvements/orphaned-dispatch';
import { claimIssue, mergeIssuePayload } from '../../issues-engineer';
import { routeExhaustedImprovementToHuman } from '../improvements/resolve-core';
import { runWatchdogTick, watchdogOptionsFromPayload } from '../improvements/watchdog';
import { runDecaySweep } from '../improvements/decay';
import {
  runHygieneSweep,
  runObservationRetention,
  DEFAULT_OBSERVATION_WINDOW_DAYS,
  DEFAULT_OBSERVATION_HARD_CAP,
} from '../improvements/hygiene';
import { runRecurrenceEscalation } from '../improvements/recurrence-escalation';
import { buildDigest, type ScoredItem } from '../improvements/digest';
import { triageIdea } from '../improvements/triage';
import { applyTriageDecision, selectUntriaged, type ApplyTriageInput, type ApplyTriageResult } from '../improvements/triage-core';

/** The claim identity the dispatch stamps on an in-flight item (close-loop D-001). */
export const IMPROVEMENT_RUNNER_ASSIGNEE = 'improvement-runner';

/**
 * P-005 (infra round-4): is the auto-implement loop configured to STOP claiming
 * new dispatches while this process is draining (SIGTERM/deploy)? Default-OFF —
 * armed only by PAPERCUSP_IMPROVEMENT_DRAIN_STOPS_CLAIMS=1|true|on. Off ⇒ the
 * guard is byte-inert (the loop behaves exactly as it did before this landed), so
 * it ships safe and is flipped on alongside the lane re-arm — the codebase's
 * default-off-until-validated pattern (PAPERCUSP_SIGTERM_DRAIN,
 * PAPERCUSP_LAG_SELF_RESTART, PAPERCUSP_CLUSTER_LAG_WATCHDOG). Pure (env
 * injectable) so it is unit-tested without the flag system.
 */
export function drainStopsImprovementClaims(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PAPERCUSP_IMPROVEMENT_DRAIN_STOPS_CLAIMS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * P-005: the wired guard — true iff the drain-stop is ARMED *and* this process is
 * draining. Pure + injectable (draining/env) so it is unit-tested without PG, the
 * flag system, or a real signal; in production both default to live process state
 * (env + the shutdown-state flag the SIGTERM handlers set via markShuttingDown()).
 */
export function shouldStopClaimingForDrain(
  opts: { draining?: boolean; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const draining = opts.draining ?? isShuttingDown();
  return drainStopsImprovementClaims(opts.env) && draining;
}

/**
 * Parse a non-negative integer env var, HONORING an explicit `0` (watchdog-robustness
 * P-005 / D-005). Returns `fallback` only when the var is unset/blank/non-numeric
 * (warning on a non-numeric value), then clamps to `min` (default 0). Replaces the
 * `Number(process.env.X ?? d) || d` idiom, which silently mapped an explicit `0`
 * (a legitimate "disable") AND any typo to the default.
 */
export function intFromEnv(name: string, fallback: number, opts: { min?: number } = {}): number {
  const min = opts.min ?? 0;
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return Math.max(min, fallback);
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim()) {
    console.warn(`[improvement-routines] ${name}="${raw}" is not an integer — using ${fallback}`);
    return Math.max(min, fallback);
  }
  return Math.max(min, n);
}

// The scheduled `improvement-digest` action was REMOVED (operator-learning-tab-2026-06-09
// D-001): its only job was pushing the triage headline to the human inbox, which
// rendered as a dead-end notification (web /coord row + zellij TUI bell, neither
// clickable, no improvements UI to open). The backlog is now surfaced by PULL in the
// Learning tab (`learning.improvements` sync resolver → the same readImprovementItems
// + buildDigest path the `improvements:digest` tool uses). The watchdog below still
// auto-files objective signals into the backlog silently.

// ── close-loop D-003: the watchdog hard feed-in (capture only) ───────────────
registerSystemAction('improvement-watchdog', async (ctx: SystemActionCtx) => {
  // Audit P-012: collector bars + caps tune from the routine's payload_template
  // (no deploy needed); the env var stays the emergency override for maxPerTick.
  const tuned = watchdogOptionsFromPayload(ctx.payloadTemplate);
  const maxPerTick = intFromEnv(
    'PAPERCUSP_IMPROVEMENT_WATCHDOG_MAX_PER_TICK',
    typeof tuned.maxPerTick === 'number' ? tuned.maxPerTick : 3,
    { min: 0 },
  );
  const result = await runWatchdogTick(ctx.workspaceId, { ...tuned, maxPerTick, installSlug: ctx.installSlug });
  if (result.status === 'skipped') {
    console.log('[improvement-watchdog] tick skipped — another host held the cross-host lock');
    return;
  }
  const failed = result.collectors.filter((c) => !c.ok).map((c) => c.name);
  console.log(
    `[improvement-watchdog] ${result.signals} signal(s) → captured ${result.captured.length}` +
      (result.captured.length ? ` (${result.captured.join(', ')})` : '') +
      `, ${result.knownOpen} known-open pre-filtered, ${result.staleResolved} stale-resolved pre-filtered` +
      `, ${result.declinedDuplicates} duplicate(s) declined, ${result.deferred} deferred by the per-tick cap` +
      (failed.length ? `, ${failed.length} collector(s) FAILED: ${failed.join(', ')}` : '') +
      (result.selfEscalations.length ? `, self-escalated ${result.selfEscalations.join(', ')}` : ''),
  );

  // Recurrence-decay verification rides the same cadence (P-013 of
  // learning-system-audit-improvements-2026-06-09): grade resolved+applied items
  // verified/recurred from post-resolution signature recurrence. Best-effort —
  // a sweep failure must never fail the capture tick.
  try {
    const decay = await runDecaySweep();
    if (decay.verified || decay.recurred || decay.initialized) {
      console.log(
        `[improvement-watchdog] decay sweep: ${decay.verified} verified, ${decay.recurred} recurred, ` +
          `${decay.initialized} legacy item(s) retro-entered the pipeline (scanned ${decay.scanned})`,
      );
    }
  } catch (e) {
    console.warn('[improvement-watchdog] decay sweep failed:', e instanceof Error ? e.message : e);
  }

  // Observation-lane retention rides the same cadence (turn-end-reflection-
  // observations-2026-06-14 P-045): the observation lane SKIPS capture-time dedup
  // (recurrence is the signal Scout clusters), so it grows unbounded once the fleet
  // reflects at turn-end at volume. Prune the surplus — older than the rolling
  // window AND beyond the hard cap — hard-deleting the disposable rows. ONLY the
  // observation topic; never the improvement lane. Best-effort — a prune failure
  // must never fail the capture tick (mirrors the decay sweep above).
  try {
    const windowDays = intFromEnv('PAPERCUSP_OBSERVATION_RETENTION_WINDOW_DAYS', DEFAULT_OBSERVATION_WINDOW_DAYS, { min: 1 });
    const hardCap = intFromEnv('PAPERCUSP_OBSERVATION_RETENTION_HARD_CAP', DEFAULT_OBSERVATION_HARD_CAP, { min: 0 });
    const retention = await runObservationRetention({ windowDays, hardCap });
    if (retention.pruned > 0) {
      console.log(
        `[improvement-watchdog] observation retention: pruned ${retention.pruned} of ${retention.scanned} ` +
          `(window ${windowDays}d, cap ${hardCap})`,
      );
    }
  } catch (e) {
    console.warn('[improvement-watchdog] observation retention failed:', e instanceof Error ? e.message : e);
  }
});

// ── P-011 (learning-system-audit): the scheduled triage pass ─────────────────
// The deterministic type-route (triageIdea: product→place, process→gate) applied
// on a cadence and PERSISTED, so every open idea carries a provisional routing
// lane instead of waiting for a Queen turn that never came. Decisions are
// re-takeable: the Queen/owner can re-triage any item via improvements:triage
// (triaged→triaged is a valid transition). The scheduled pass never rejects and
// never dispatches — it only records routing metadata.

/** The apply seam — injectable for tests (mirrors the implement fire seam). */
export type TriageApplyFn = (input: ApplyTriageInput) => Promise<ApplyTriageResult>;

let _applyTriage: TriageApplyFn | null = null;
/** Override the triage persistence (tests). Pass null to restore the default. */
export function setImprovementTriageApply(fn: TriageApplyFn | null): void {
  _applyTriage = fn;
}

registerSystemAction('improvement-triage', async (_ctx: SystemActionCtx) => {
  const maxPerRun = intFromEnv('PAPERCUSP_IMPROVEMENT_TRIAGE_MAX_PER_RUN', 25, { min: 0 });
  const items = await readImprovementItems({ state: 'open' });
  const digest = buildDigest(items);
  const batch = selectUntriaged(digest.autoEligible.concat(digest.humanQueue), maxPerRun);
  if (batch.length === 0) {
    console.log('[improvement-triage] nothing untriaged — backlog fully routed');
    return;
  }
  const apply = _applyTriage ?? applyTriageDecision;
  let applied = 0;
  const byDecision: Record<string, number> = {};
  for (const item of batch) {
    const triage = triageIdea(item);
    const res = await apply({
      id: item.id,
      decision: triage.decision,
      reason: triage.reason,
      by: 'improvement-triage',
      comment: false, // batch pass — no per-item thread spam; the lifecycle carries the decision
    });
    if (res.ok) {
      applied += 1;
      byDecision[triage.decision] = (byDecision[triage.decision] ?? 0) + 1;
    }
  }
  console.log(
    `[improvement-triage] routed ${applied}/${batch.length} untriaged item(s): ` +
      Object.entries(byDecision)
        .map(([d, n]) => `${d}=${n}`)
        .join(', '),
  );

  // Hygiene rides the triage cadence (P-014): dup-cluster closes + stale-minor
  // age-outs, small recurring cap (the one-time backlog cut runs separately).
  // Best-effort — hygiene failure must never fail the triage pass.
  try {
    const hygieneCap = intFromEnv('PAPERCUSP_IMPROVEMENT_HYGIENE_MAX_PER_RUN', 10, { min: 0 });
    const hygiene = await runHygieneSweep({ maxActions: hygieneCap });
    if (hygiene.planned.length > 0) {
      console.log(
        `[improvement-triage] hygiene: ${hygiene.dupClosed} dup-closed, ${hygiene.agedOut} aged out (scanned ${hygiene.scanned})`,
      );
    }
  } catch (e) {
    console.warn('[improvement-triage] hygiene sweep failed:', e instanceof Error ? e.message : e);
  }

  // Recurrence escalation (P-053 + P-052 lite): ≥3× signatures escalate severity /
  // route process-class to the gym / propose cross-scope lesson promotion.
  // Best-effort — never fails the triage pass.
  try {
    const esc = await runRecurrenceEscalation();
    if (esc.escalated || esc.gymRouted || esc.promotionsSuggested) {
      console.log(
        `[improvement-triage] recurrence escalation: ${esc.escalated} severity-escalated, ` +
          `${esc.gymRouted} routed to gym, ${esc.promotionsSuggested} lesson-promotion(s) proposed`,
      );
    }
  } catch (e) {
    console.warn('[improvement-triage] recurrence escalation failed:', e instanceof Error ? e.message : e);
  }
});

// ── Phase 3: the auto-implement loop (flag-gated OFF) ────────────────────────

/**
 * The dispatch seam — injectable for tests (mirrors blueprint-run-action's fire fn).
 * EI-403-A: the default no longer FIRES inside the routine step (a child workflow
 * can't start there). It BUILDS a durable-spawn request and returns it as
 * `durableSpawn`; the dispatch loop collects these and returns them as
 * `SystemActionResult.durableSpawns`, which the routine workflow starts durably
 * AFTER the step. A seam that returns void / no `durableSpawn` (the test default)
 * dispatches nothing — exactly as before.
 */
export type ImplementFireFn = (input: {
  runnerHarness: string;
  workspaceId: string;
  candidate: ScoredItem;
  /** The dispatch ledger row id for THIS fire — threaded to the /invoke route so its
   *  worker-exit back-edge (EI-404) can record the death on this row. Null when the
   *  ledger insert failed (the orphan collector stays the 2h catch-all). */
  dispatchId?: string | null;
}) => void | ImplementFireResult | Promise<void | ImplementFireResult>;

export interface ImplementFireResult {
  /** spawn correlation recorded on the ledger row as spawned_run_id (NULL if absent). */
  spawnedRunId?: string | null;
  /** EI-403-A: the durable fire to start at the workflow layer after the step. */
  durableSpawn?: DurableSpawnFireInput;
}

let _fire: ImplementFireFn | null = null;
/** Override the dispatch fn (tests). Pass null to restore the default invoke fire. */
export function setImprovementImplementFire(fn: ImplementFireFn | null): void {
  _fire = fn;
}

/**
 * The kickoff the implement worker receives. It carries the WHOLE per-item
 * contract — which item, what to do, and the resolve back-edge it MUST call
 * (close-loop D-001) — so the loop closes even before the worker reads its
 * blueprint prompt (blueprints/implement/prompts/worker.md, the long form).
 */
export function implementKickoff(candidate: Pick<ScoredItem, 'id' | 'title' | 'attempts'>): string {
  return (
    `Auto-implement papercusp improvement ${candidate.id} (kind=bug): "${candidate.title}". ` +
    `Reproduce, fix with a regression test, run the affected tests, keep it self/inline-sized. ` +
    `When VERIFIED green, you MUST call improvements:resolve { id: '${candidate.id}', outcome: 'fixed', summary, testsRun } ` +
    `so the bug leaves the queue. If you cannot fix it, call improvements:resolve with outcome 'could-not-fix'. ` +
    `If the fix would touch operator-core safety / the deploy machinery / a migration, STOP and call ` +
    `improvements:resolve with outcome 'needs-human'. The change lands via the release gate.` +
    ((candidate.attempts ?? 0) > 0 ? ` (Dispatch attempt ${(candidate.attempts ?? 0) + 1} — earlier attempts failed; read the issue comments first.)` : '')
  );
}

/**
 * Default dispatch: fire the `implement` LAUNCH BLUEPRINT at the DEDICATED runner
 * harness (D-006) — `fireLaunchBlueprint` resolves the role from the blueprint
 * (decider worker) AND passes `BLUEPRINT_ID=implement`, so the worker gets the
 * blueprint-owned prompt (blueprints/implement/prompts/worker.md). The runner
 * implements + verifies, calls `improvements:resolve` (the back-edge), and the
 * change lands via the release gate (D-008). Fire-and-forget. (This path only
 * ever runs when an owner has flipped the flag AND configured the runner harness
 * — see planImplementRun's gates; until then it is unreachable.)
 */
/**
 * Worker lifetime for one implement dispatch. Reproduce + fix + regression test +
 * test:affected does not fit the invoke route's smaller defaults — the first armed
 * week ran at 280s and SIGTERM'd 51/58 workers mid-fix (exit 143,
 * learning-system-audit-improvements-2026-06-09 D-010). Must stay well under
 * plan-implement's DEFAULT_STALE_CLAIM_MS (2h) so a timed-out item's claim goes
 * stale only AFTER its worker is dead — never two workers on one item.
 */
export function implementTimeoutMs(): number {
  return intFromEnv('PAPERCUSP_IMPROVEMENT_IMPLEMENT_TIMEOUT_MS', 2_700_000, { min: 60_000 });
}

const defaultFire: ImplementFireFn = async ({ runnerHarness, workspaceId, candidate, dispatchId }) => {
  const attempt = (candidate.attempts ?? 0) + 1;
  // STABLE idempotency key (EI-403-A): derived from durable item state, never a
  // clock, so a recovery replay of this dispatch re-fires the SAME durable workflow
  // (`durable-spawn:<key>`) and dedups instead of double-dispatching. One key per
  // genuine attempt (markDispatched bumps the attempt each dispatch).
  const idempotencyKey = `implement:${candidate.id}:${attempt}`;
  const durableSpawn = await buildLaunchSpawnRequest(
    'implement',
    {
      installSlug: runnerHarness,
      workspaceId,
      kickoff: implementKickoff(candidate),
      timeoutMs: implementTimeoutMs(),
      // Correlation for the worker-exit back-edge (EI-404): the /invoke route records
      // the worker's death on THIS ledger row at close time (visible in seconds, vs
      // the 2h orphan threshold) and rolls back the attempt on an env-failure (EI-406).
      bodyExtra: dispatchId
        ? { improvementDispatch: { dispatchId, itemId: candidate.id, attempt } }
        : undefined,
    },
    idempotencyKey,
  );
  // The fire happens at the workflow layer (the engine drains durableSpawns); the
  // durable workflow id IS the spawn correlation, recorded now (fire_result 'ok'
  // here means "durably handed off" — the same optimistic point the old fire-and-
  // forget recorded 'ok', before its loopbackFetch even landed).
  return { spawnedRunId: `durable-spawn:${idempotencyKey}`, durableSpawn };
};

/**
 * The dispatch-bookkeeping seam (close-loop D-001) — stamps an item IN-FLIGHT
 * before the fire: claim it as `improvement-runner` (assignee + assigned_at →
 * the in-flight skip on the next tick) and bump `payload.implementAttempts`
 * (the anti-ping-pong counter improvements:resolve grades against). Injectable
 * so unit tests observe it without PG.
 */
export type MarkDispatchedFn = (candidate: ScoredItem) => void | Promise<void>;

let _markDispatched: MarkDispatchedFn | null = null;
/** Override the dispatch bookkeeping (tests). Pass null to restore the default. */
export function setImprovementMarkDispatched(fn: MarkDispatchedFn | null): void {
  _markDispatched = fn;
}

const defaultMarkDispatched: MarkDispatchedFn = async (candidate) => {
  await claimIssue(candidate.id, IMPROVEMENT_RUNNER_ASSIGNEE);
  await mergeIssuePayload(candidate.id, {
    implementAttempts: (candidate.attempts ?? 0) + 1,
    lastDispatchAt: new Date().toISOString(),
  });
};

/**
 * The dispatch-ledger seam (consume-edges P-010 / B-04) — the durable
 * dispatch → fire-result record in harness_shared.improvement_dispatches
 * (dispatch-ledger.ts; migration 238). Injectable so the handler test observes
 * the writes without PG. Both fns swallow + warn on PG failure — accounting
 * never blocks the dispatch itself.
 */
export interface DispatchLedgerFns {
  recordDispatchFired: typeof recordDispatchFired;
  recordFireResult: typeof recordFireResult;
}

let _ledger: DispatchLedgerFns | null = null;
/** Override the dispatch ledger (tests). Pass null to restore the PG-backed default. */
export function setImprovementDispatchLedger(fns: DispatchLedgerFns | null): void {
  _ledger = fns;
}

/**
 * The exhausted⇒needs-human flip seam (consume-edges P-012) — injectable so the
 * handler test observes the flip without PG. Default: resolve-core's
 * routeExhaustedImprovementToHuman (comment + needsHuman + release the stale claim).
 */
export type ExhaustedFlipFn = (candidate: ScoredItem, maxAttempts?: number) => void | Promise<void>;

let _flipExhausted: ExhaustedFlipFn | null = null;
/** Override the exhausted flip (tests). Pass null to restore the default. */
export function setImprovementExhaustedFlip(fn: ExhaustedFlipFn | null): void {
  _flipExhausted = fn;
}

const defaultFlipExhausted: ExhaustedFlipFn = async (candidate, maxAttempts) => {
  await routeExhaustedImprovementToHuman({
    id: candidate.id,
    attempts: candidate.attempts,
    maxAttempts,
    by: 'improvement-implement',
  });
};

registerSystemAction('improvement-implement', async (ctx: SystemActionCtx): Promise<void | SystemActionResult> => {
  const items = await readImprovementItems({ state: 'open' });
  const flagEnabled = await getFlag(FLAGS.IMPROVEMENT_AUTO_IMPLEMENT, `routine:${ctx.installSlug}`);
  // The OWNER FULL-AUTONOMY grant (queen-autonomy-and-selffeed-fix Phase 2): when ON,
  // the tier split lifts the protected-path/keyword TCB bars so a kind=bug touching the
  // deploy gate / flags / capability dispatch / migrations / the loop's own code is
  // dispatchable. Read at `autonomy:<ws>` (the same key the decider reads), so one owner
  // flip covers both the decision gate + this implement lane. Fail-DARK (helper).
  const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ctx.workspaceId);
  // WI-290: default the runner harness to the routine's OWN install slug when the env
  // override is unset. This previously read ONLY a per-tree/per-process untracked
  // `.env.local` var — a config single-point-of-failure. When the executor that actually
  // runs the routines (the dedicated bg-host, on the staging tree) lacked it — a drift a
  // restart / routine-consolidation can silently introduce — `planImplementRun` returned
  // action='no-runner' EVERY tick and dispatched nothing, with only a console.log. The
  // routine's liveness signal (last_fired_at) kept advancing, so the lane went dark and
  // STAYED dark (35h after the 2026-06-19 host-restart orphan storm; ~200 dispatchable
  // bugs stranded) with nothing detecting it. The dispatch is ALWAYS a fresh durable child
  // spawn (EI-403-A) that lands via the release gate — never an in-process modification —
  // so the routine's own install slug is the correct default runner; the env now only
  // OVERRIDES it to a DIFFERENT harness. `planImplementRun`'s pure no-runner guard stays
  // intact (the `|| null` tail still trips it if neither resolves — e.g. an empty slug).
  const runnerHarness = process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS || ctx.installSlug || null;
  // live-configurability-audit P-011: the stored auto-implement policy (riskTier + dispatch limits)
  // overrides the env value-gates / DEFAULT_RISK_TIER_POLICY; an empty store ⇒ env/default ⇒
  // byte-identical. Inert until IMPROVEMENT_AUTO_IMPLEMENT is armed (flagEnabled below).
  const storedAutoPolicy = await readAutoImplementPolicy();
  const maxPerRun = storedAutoPolicy.maxPerRun ?? intFromEnv('PAPERCUSP_IMPROVEMENT_MAX_PER_RUN', 1, { min: 0 });
  // maxAttempts is genuinely optional (undefined = no cap). Honor an explicit 0
  // (a valid "never dispatch" pause) when set; leave undefined when unset/blank.
  const maxAttemptsRaw = process.env.PAPERCUSP_IMPROVEMENT_MAX_ATTEMPTS;
  const maxAttempts =
    storedAutoPolicy.maxAttempts ??
    (maxAttemptsRaw && maxAttemptsRaw.trim() !== ''
      ? intFromEnv('PAPERCUSP_IMPROVEMENT_MAX_ATTEMPTS', 0, { min: 0 })
      : undefined);

  // P-032: PAUSE the lane during a fleet credential/env outage so it stops dispatching
  // workers that die instantly on rate-limit/auth (and stops generating orphan noise —
  // the capture side already suppresses it, P-010). Reuses laneInEnvOutage over the recent
  // dispatch ledger, with a tighter window than the capture side so the lane probes recovery
  // as soon as env deaths age out. Only when armed; a ledger-read failure ⇒ treat as no outage.
  let laneEnvOutage = false;
  if (flagEnabled) {
    try {
      const windowMs = intFromEnv('PAPERCUSP_IMPROVEMENT_ENV_PAUSE_WINDOW_MS', 90 * 60_000, { min: 60_000 });
      const recent = await readRecentDispatches(ctx.workspaceId, { limit: 50 });
      laneEnvOutage = laneInEnvOutage(recent, { nowMs: Date.now(), windowMs });
    } catch (e) {
      console.warn('[improvement-implement] env-outage pause check skipped (ledger read failed):', e instanceof Error ? e.message : e);
    }
  }

  const plan = planImplementRun({ items, flagEnabled, runnerHarness, maxPerRun, maxAttempts, laneEnvOutage, ownerFullAutonomy, policy: storedAutoPolicy.riskTier });

  // Exhausted-without-resolve ⇒ needs-human (consume-edges P-012): an item whose
  // dispatch attempts exhausted with no improvements:resolve ever recorded (silent
  // worker death) is stranded — never dispatchable again, never human-routed. Flip
  // each to the human tier EVERY tick, whatever the plan action (a disarmed lane
  // still surfaces its strays). Best-effort per item: a flip failure never blocks
  // the dispatch loop; the flip is idempotent, so the next tick retries.
  const flipExhausted = _flipExhausted ?? defaultFlipExhausted;
  for (const stranded of plan.attemptsExhausted) {
    try {
      await flipExhausted(stranded, maxAttempts);
      console.log(
        `[improvement-implement] ${stranded.id} exhausted ${stranded.attempts ?? '?'} dispatch attempt(s) with no resolve recorded — routed to the human tier (P-012)`,
      );
    } catch (e) {
      console.warn(`[improvement-implement] exhausted⇒needs-human flip failed for ${stranded.id}:`, e instanceof Error ? e.message : e);
    }
  }

  if (plan.action !== 'dispatch') {
    console.log(`[improvement-implement] ${plan.action}: ${plan.message}`);
    return;
  }
  // P-005 (infra round-4): during a graceful drain (SIGTERM/deploy) do NOT START a
  // new dispatch batch. A worker spawned now runs for minutes and would be SIGKILL'd
  // by the drain's hard-exit backstop mid-fix, orphaning its claim and churning
  // re-dispatch across the deploy (the 2026-06-19 storm: 51/58 workers exited 143).
  // Items already in-flight stay claimed (stale-claim reclaim handles them); we only
  // stop ADDING to the doomed set. Default-OFF until armed (see the helper), so it
  // lands inert and is flipped on with the lane re-arm.
  if (shouldStopClaimingForDrain()) {
    console.log(
      `[improvement-implement] drain in progress (SIGTERM) — declining ${plan.candidates.length} ` +
        `new dispatch(es); in-flight claims unaffected (P-005)`,
    );
    return;
  }
  console.log(`[improvement-implement] ${plan.message}`);
  const fire = _fire ?? defaultFire;
  const markDispatched = _markDispatched ?? defaultMarkDispatched;
  const ledger = _ledger ?? { recordDispatchFired, recordFireResult };
  // EI-403-A: the action no longer fires inside this step — it COLLECTS the durable
  // fire requests and returns them; the routine workflow starts them durably AFTER
  // the step (where startWorkflow is legal). See routines-workflow.ts → startDurableSpawns.
  const durableSpawns: DurableSpawnFireInput[] = [];
  for (const candidate of plan.candidates) {
    // P-005: SIGTERM can land MID-batch (maxPerRun > 1). Re-check before claiming the
    // next item so the already-fired ones drain while the rest wait for the first
    // post-restart tick — never claimed-then-killed.
    if (shouldStopClaimingForDrain()) {
      console.log(`[improvement-implement] drain began mid-batch — stopping before ${candidate.id} (P-005)`);
      break;
    }
    // Bookkeeping FIRST (claim + attempt bump) so a fire that crashes mid-loop
    // still leaves the item in-flight rather than double-dispatchable.
    await markDispatched(candidate);
    // Ledger row BEFORE the fire (P-010): a dispatcher crash between insert and
    // fire leaves a 'pending' row — visible, not silent. The fire's success or
    // failure then drives it: 'ok' (worker in progress, spawned_run_id recorded)
    // or terminal 'fire-failed'. A fire failure no longer aborts the loop — the
    // item stays claimed (stale-claim reclaim backs it off; no hot re-dispatch)
    // and the remaining candidates still dispatch.
    // (per-hive-learning-loops P-012) Stamp the dispatch with the Hive that owns the
    // item — resolved from its scope tag (P-032) — so per-hive dispatch diagnostics
    // align with the per-hive improvement lens. Best-effort: NULL for an operator-
    // scoped item or any resolution failure; never blocks the dispatch.
    let dispatchHiveSlug: string | null = null;
    const candidateScope = (candidate as { scope?: string }).scope;
    if (candidateScope && candidateScope.startsWith('harness:')) {
      const h = candidateScope.slice('harness:'.length);
      try {
        const { hiveHomeSlugForHarness } = await import('../../hive-federation');
        dispatchHiveSlug = (await hiveHomeSlugForHarness(ctx.workspaceId, h)) ?? h;
      } catch {
        dispatchHiveSlug = h;
      }
    }
    const dispatchId = await ledger.recordDispatchFired({
      workspaceId: ctx.workspaceId,
      itemId: candidate.id,
      attempt: (candidate.attempts ?? 0) + 1,
      runnerHarness,
      potSlug: dispatchHiveSlug,
    });
    try {
      const fired = await fire({ runnerHarness: runnerHarness as string, workspaceId: ctx.workspaceId, candidate, dispatchId });
      if (fired && typeof fired === 'object' && fired.durableSpawn) durableSpawns.push(fired.durableSpawn);
      if (dispatchId) {
        const spawnedRunId = fired && typeof fired === 'object' ? (fired.spawnedRunId ?? null) : null;
        await ledger.recordFireResult(dispatchId, { ok: true, spawnedRunId });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[improvement-implement] fire FAILED for ${candidate.id}: ${msg}`);
      if (dispatchId) await ledger.recordFireResult(dispatchId, { ok: false, error: msg });
    }
  }
  // Hand the collected fires to the engine to start durably at the workflow layer
  // (EI-403-A). Nothing to start ⇒ void (a build seam that returned no request).
  return durableSpawns.length ? { durableSpawns } : undefined;
});
