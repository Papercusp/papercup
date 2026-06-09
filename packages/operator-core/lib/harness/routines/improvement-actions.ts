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
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { fireLaunchBlueprint } from '../../blueprint/launch-blueprint';
import { readImprovementItems } from '../improvements/read-items';
import { planImplementRun } from '../improvements/plan-implement';
import { claimIssue, mergeIssuePayload } from '../../issues-engineer';
import { runWatchdogTick, watchdogOptionsFromPayload } from '../improvements/watchdog';
import { runDecaySweep } from '../improvements/decay';
import { runHygieneSweep } from '../improvements/hygiene';
import { runRecurrenceEscalation } from '../improvements/recurrence-escalation';
import { buildDigest, type ScoredItem } from '../improvements/digest';
import { triageIdea } from '../improvements/triage';
import { applyTriageDecision, selectUntriaged, type ApplyTriageInput, type ApplyTriageResult } from '../improvements/triage-core';

/** The claim identity the dispatch stamps on an in-flight item (close-loop D-001). */
export const IMPROVEMENT_RUNNER_ASSIGNEE = 'improvement-runner';

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

/** The dispatch seam — injectable for tests (mirrors blueprint-run-action's fire fn). */
export type ImplementFireFn = (input: {
  runnerHarness: string;
  workspaceId: string;
  candidate: ScoredItem;
}) => void | Promise<void>;

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
const defaultFire: ImplementFireFn = async ({ runnerHarness, workspaceId, candidate }) => {
  await fireLaunchBlueprint('implement', {
    installSlug: runnerHarness,
    workspaceId,
    kickoff: implementKickoff(candidate),
    timeoutMs: 280_000,
  });
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

registerSystemAction('improvement-implement', async (ctx: SystemActionCtx) => {
  const items = await readImprovementItems({ state: 'open' });
  const flagEnabled = await getFlag(FLAGS.IMPROVEMENT_AUTO_IMPLEMENT, `routine:${ctx.installSlug}`);
  const runnerHarness = process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS || null;
  const maxPerRun = intFromEnv('PAPERCUSP_IMPROVEMENT_MAX_PER_RUN', 1, { min: 0 });
  // maxAttempts is genuinely optional (undefined = no cap). Honor an explicit 0
  // (a valid "never dispatch" pause) when set; leave undefined when unset/blank.
  const maxAttemptsRaw = process.env.PAPERCUSP_IMPROVEMENT_MAX_ATTEMPTS;
  const maxAttempts =
    maxAttemptsRaw && maxAttemptsRaw.trim() !== ''
      ? intFromEnv('PAPERCUSP_IMPROVEMENT_MAX_ATTEMPTS', 0, { min: 0 })
      : undefined;

  const plan = planImplementRun({ items, flagEnabled, runnerHarness, maxPerRun, maxAttempts });
  if (plan.action !== 'dispatch') {
    console.log(`[improvement-implement] ${plan.action}: ${plan.message}`);
    return;
  }
  console.log(`[improvement-implement] ${plan.message}`);
  const fire = _fire ?? defaultFire;
  const markDispatched = _markDispatched ?? defaultMarkDispatched;
  for (const candidate of plan.candidates) {
    // Bookkeeping FIRST (claim + attempt bump) so a fire that crashes mid-loop
    // still leaves the item in-flight rather than double-dispatchable.
    await markDispatched(candidate);
    await fire({ runnerHarness: runnerHarness as string, workspaceId: ctx.workspaceId, candidate });
  }
});
