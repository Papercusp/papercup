/**
 * overwatch/loop — the autonomous overwatch wake-loop (overwatch-role-2026-06-15
 * B-04, owns C-3).
 *
 * This is the LAUNCH half of the overwatch's autonomous loop — the analogue of the
 * Queen's `system:blueprint-run` → hive launch, but on the overwatch's OWN wake
 * channel (it must NOT ride the Queen's `hive-wake`; that would collide). It wires
 * three things, reusing the seams the sibling briefs already landed:
 *
 *   1. **The `system:overwatch-launch` action** (`OVERWATCH_WAKE_TARGET_ACTION`,
 *      liveness.ts) — fired by the one-shot `overwatch-wake` routine when due. It
 *      computes the OverwatchBrief (B-03 `computeOverwatchBrief` → B-02
 *      `renderOverwatchBrief`) and launches role=overwatch via the invoke route
 *      with the brief injected (`bpkind=overwatch`, `BLUEPRINT_ID=coding` so the
 *      persona resolves at `blueprints/coding/prompts/overwatch.md`, B-05/D-010).
 *      The brief rides the /invoke body as `overwatchBrief`; the route sets
 *      `OVERWATCH_WAKE_BRIEF`; invoke.ts hands it to buildPrompt as a
 *      `<system-reminder>` tail block (mirrors the Queen's QUEEN_WAKE_BRIEF).
 *
 *   2. **The waker** (`registerOverwatchWaker`, wake-bridge.ts) — the B-07 ↔ B-04
 *      seam: `overwatch:start` requests an immediate wake / `overwatch:pause`
 *      clears the pending one, both through this module's `requestWake`/`clearWake`,
 *      which arm/clear the one-shot `overwatch-wake` routine via
 *      `declareOverwatchTimeWake`/`clearOverwatchTimeWake` (liveness.ts).
 *
 *   3. **declare-next-wake** — NOT here. The overwatch declares its own next wake
 *      at turn-end via the `overwatch:declare-wake` tool (agent-tools/overwatch/
 *      declare_wake.ts), which calls the SAME `declareOverwatchTimeWake` primitive.
 *      The action deliberately does NOT pre-arm a cadence wake: at a short cadence a
 *      pre-armed wake could fire mid-turn and double-launch the overwatch. So the
 *      next wake is armed only AFTER a turn ends (the persona declares it; B-09's
 *      `overwatchTurnEndCheck` backstops a forgotten declaration with a fallback
 *      SLEEP) — exactly the proven hive model.
 *
 * GATING (B-10/D-009/D-013): the action self-gates on `FLAGS.OVERWATCH` AND B-07's
 * started bit before doing any work, and the central spawn chokepoint
 * (operator-spawn.ts) independently rejects a role=overwatch launch while the flag
 * is off. Flag off ⇒ nothing here ever launches the role. Stays dark until B-12.
 *
 * The fire is injectable (`setOverwatchLaunchFire`) so unit tests capture the
 * dispatch without a real HTTP call (the codebase's `setBlueprintRunFire` pattern).
 */
import { getOrgPg } from '@papercusp/db-org';
import { loopbackFetch } from '../loopback-fetch';
import { operatorApiBase } from '../operator-api-base';
import { recordFire } from '../autoloop';
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import {
  OVERWATCH_ROLE,
  OVERWATCH_BLUEPRINT_ID,
  OVERWATCH_WAKE_TARGET_ACTION,
  declareOverwatchTimeWake,
  clearOverwatchTimeWake,
} from './liveness';
import { getOverwatchStarted } from './control-state';
import { overwatchEnabled } from './watchdog';
import { computeOverwatchBrief } from './compute-brief';
import { renderOverwatchBrief } from './brief-types';
import { registerOverwatchWaker } from './wake-bridge';

const operatorBase = operatorApiBase;

/** The registry key for the launch action — derived from the contract constant
 *  (liveness.ts) so a rename of the action follows automatically. */
const OVERWATCH_LAUNCH_ACTION = OVERWATCH_WAKE_TARGET_ACTION.startsWith('system:')
  ? OVERWATCH_WAKE_TARGET_ACTION.slice('system:'.length)
  : OVERWATCH_WAKE_TARGET_ACTION;

/** Input to the overwatch launch fire — the resolved role + the computed brief. */
export interface OverwatchLaunchFireInput {
  installSlug: string;
  workspaceId: string;
  role: string;
  /** Human-readable wake reason (the routine's payload kickoff). */
  kickoff: string;
  /** The rendered OverwatchBrief, or null when its precompute degraded (the
   *  persona then gathers the panels itself — overwatch.md's fallback). */
  brief: string | null;
}

export type OverwatchLaunchFireFn = (input: OverwatchLaunchFireInput) => void | Promise<void>;

let _fire: OverwatchLaunchFireFn | null = null;
/** Override the launch fire (tests). Pass `null` to restore the default invoke fire. */
export function setOverwatchLaunchFire(fn: OverwatchLaunchFireFn | null): void {
  _fire = fn;
}

/**
 * The default fire: invoke role=overwatch via the loopback invoke route with the
 * brief threaded through the POST body. Fire-and-forget (the invoke route runs the
 * agent to completion up to its timeout; a scheduled launch must not block the
 * durable step on the whole agent lifetime — the next declared wake re-fires).
 * Mirrors blueprint-run-action.ts's `defaultFire`.
 */
const defaultOverwatchFire: OverwatchLaunchFireFn = ({ installSlug, workspaceId, role, kickoff, brief }) => {
  const ws = encodeURIComponent(workspaceId);
  // `bpkind=overwatch` tells the invoke route to record a TRACKED, resumable
  // session (label `overwatch · <slug>/<role>`, matching overwatchMidTurn) AND to
  // run `overwatchTurnEndCheck` (not the hive's) when the turn ends.
  const url = `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(role)}&ws=${ws}&bpkind=overwatch`;
  const body: Record<string, unknown> = {
    kickoff,
    // `BLUEPRINT_ID=coding` scopes the role's prompt resolution to
    // `blueprints/coding/prompts/overwatch.md` (the canonical persona, B-05/D-010),
    // falling back to the global stub if absent (D-007).
    extra: [`BLUEPRINT_ID=${OVERWATCH_BLUEPRINT_ID}`],
  };
  if (brief) body.overwatchBrief = brief;
  // Stamp the attempt, then refresh the pane's "is-it-alive?" heartbeat strip:
  // `recordFire` wrote a fresh `autoloop_state` row that `overwatch.liveness`
  // reads, so the strip's last-run / countdown / ALIVE badge update live over SSE
  // the moment a wake fires. Name-only (the consumer subscribes with no args).
  void recordFire(installSlug, role, 'firing', 'attempt').catch(() => {}).finally(invalidateOverwatchLiveness);
  void loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(
      async (r) => {
        if (r.ok) return recordFire(installSlug, role, 'ok', 'ok');
        const detail = await r
          .text()
          .then((t) => t.replace(/\s+/g, ' ').slice(0, 160))
          .catch(() => '');
        return recordFire(installSlug, role, `error: HTTP ${r.status}${detail ? ` — ${detail}` : ''}`, 'error');
      },
      (e) => {
        const detail = String(e instanceof Error ? e.message : e).slice(0, 180);
        console.warn(`[overwatch-loop] launch fire failed (${installSlug}/${role}): ${detail}`);
        return recordFire(installSlug, role, `error: ${detail}`, 'error');
      },
    )
    .catch(() => {})
    .finally(invalidateOverwatchLiveness);
};

/** Refresh the `overwatch.liveness` sync subscribers (the "is-it-alive?" strip)
 *  after a fire stamps `autoloop_state`. Lazy import (the loop module is imported
 *  at boot, before the SSE bus is necessarily wired) + fully fail-soft — a notify
 *  miss never affects the launch. */
function invalidateOverwatchLiveness(): void {
  void import('../sync-sse')
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('overwatch.liveness', {}))
    .catch(() => {});
}

/**
 * The registered `system:overwatch-launch` handler. Self-gates (flag + started),
 * computes the brief fail-soft, and fires the role launch. NEVER throws — it runs
 * inside a retryable DBOS step (routines-workflow.ts), and a throw after firing
 * would double-launch the overwatch on retry; every failure mode degrades to "no
 * launch this tick" (the watchdog re-arms a fallback if the channel goes quiet).
 */
export async function handleOverwatchLaunch(ctx: SystemActionCtx): Promise<void> {
  const { installSlug, workspaceId, payloadTemplate } = ctx;
  try {
    // Defense-in-depth (the spawn chokepoint also rejects role=overwatch while the
    // flag is off): skip cheaply when the role is dark or the loop is paused so we
    // never compute a brief / fire a launch that the chokepoint would reject anyway.
    if (!(await overwatchEnabled())) {
      console.log(`[overwatch-loop] ${installSlug}: launch skipped — overwatch flag off`);
      return;
    }
    if (!(await getOverwatchStarted(workspaceId, installSlug))) {
      console.log(`[overwatch-loop] ${installSlug}: launch skipped — overwatch not started`);
      return;
    }

    const kickoff =
      typeof payloadTemplate?.kickoff === 'string' && payloadTemplate.kickoff.trim()
        ? payloadTemplate.kickoff.trim()
        : `Scheduled overwatch wake for '${installSlug}'. Survey system health (the brief) and act on the anomalies.`;

    // Precompute the brief (B-03 → B-02). computeOverwatchBrief is itself fail-soft
    // (catastrophic failure → the neutral emptyOverwatchBrief), but wrap defensively
    // so a render/compute throw never aborts the launch — a null brief launches the
    // overwatch to gather the panels itself (overwatch.md's degraded fallback).
    let brief: string | null = null;
    try {
      const computed = await computeOverwatchBrief(workspaceId, installSlug, { wokeBy: kickoff });
      brief = renderOverwatchBrief(computed);
    } catch (e) {
      console.warn(
        `[overwatch-loop] ${installSlug}: brief precompute failed — launching without it: ${e instanceof Error ? e.message : e}`,
      );
      brief = null;
    }

    const fire = _fire ?? defaultOverwatchFire;
    await fire({ installSlug, workspaceId, role: OVERWATCH_ROLE, kickoff, brief });
    console.log(`[overwatch-loop] ${installSlug}: fired overwatch launch (brief ${brief ? 'attached' : 'absent'})`);
  } catch (e) {
    // The whole handler is fail-soft (the durable-step contract): never throw.
    console.warn(`[overwatch-loop] ${installSlug}: launch handler failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ── register the action + the waker at module load ────────────────────────────

registerSystemAction(OVERWATCH_LAUNCH_ACTION, handleOverwatchLaunch);

/**
 * Wire the real wake-launch into the B-07 control seam (wake-bridge.ts). Until this
 * runs, `overwatch:start`/`overwatch:pause` calls through `requestOverwatchWake`/
 * `clearOverwatchWake` are fail-soft no-ops; once registered they arm/clear the
 * one-shot `overwatch-wake` routine the action above fires.
 */
registerOverwatchWaker({
  async requestWake({ harness, workspaceId, reason }) {
    const { sql } = getOrgPg();
    // `at: now` is clamped to now+floor by declareOverwatchTimeWake — the first
    // wake fires on the next routine tick past the floor (no instant spin).
    return declareOverwatchTimeWake(sql, {
      workspaceId,
      installSlug: harness,
      at: new Date(),
      kickoff: reason,
    });
  },
  async clearWake({ harness }) {
    const { sql } = getOrgPg();
    await clearOverwatchTimeWake(sql, harness);
    return { cleared: true };
  },
});
