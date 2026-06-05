/**
 * Self-improvement-loop system actions (papercusp-self-improvement-loop-2026-06-04,
 * Phase 2 + Phase 3). Two routines, registered here so the routines engine can
 * fire them; both SEEDED INACTIVE (seed-improvement-routines.ts):
 *
 *   - `system:improvement-digest` (Phase 2) — read the captured
 *     `papercusp-improvement` backlog, score + dedup + tier it, log the headline
 *     and best-effort surface it to the human inbox. Triage only — builds nothing.
 *
 *   - `system:improvement-implement` (Phase 3) — the AUTO-implement loop, gated by
 *     the `papercusp-improvement-auto-implement` flag (default OFF). When OFF it
 *     no-ops (just reports the waiting count). When ON it dispatches up to a cap of
 *     auto-eligible bugs (D-004) to a DEDICATED runner harness (D-006) — never
 *     in-process — which lands them via the release gate (D-008) + the
 *     release-manager (D-005). The decision is the pure `planImplementRun`; this
 *     handler is thin glue + the dispatch.
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
import { buildDigest } from '../improvements/digest';
import { planImplementRun } from '../improvements/plan-implement';
import { claimIssue, mergeIssuePayload } from '../../issues-engineer';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import type { ScoredItem } from '../improvements/digest';

/** The claim identity the dispatch stamps on an in-flight item (close-loop D-001). */
export const IMPROVEMENT_RUNNER_ASSIGNEE = 'improvement-runner';

/** A stable system identity for the digest broadcast (display-only ownerLabel). */
function systemIdentity(ctx: SystemActionCtx, who: string): AgentIdentity {
  return { ownerId: `system:${who}`, ownerLabel: who, source: 'principal', workspaceId: ctx.workspaceId, userId: null };
}

// ── Phase 2: the scheduled triage digest ────────────────────────────────────
registerSystemAction('improvement-digest', async (ctx: SystemActionCtx) => {
  const items = await readImprovementItems({});
  const digest = buildDigest(items, { nowMs: Date.now() });
  console.log(`[improvement-digest] ${digest.headline}`);
  if (digest.open === 0) return; // nothing to surface

  // Best-effort: surface the triage to the human inbox so it doesn't need polling.
  try {
    const top = (q: ScoredItem[]): string =>
      q.slice(0, 5).map((i) => `  • ${i.id} [${i.kind}/${i.severity ?? '?'}] ${i.title} (score ${i.score})`).join('\n') || '  (none)';
    const body =
      `Auto-eligible (kind=bug, safe surface):\n${top(digest.autoEligible)}\n\n` +
      `Needs a human:\n${top(digest.humanQueue)}` +
      (digest.likelyDuplicates.length ? `\n\nLikely-duplicate clusters: ${digest.likelyDuplicates.map((c) => c.ids.join('=')).join(' | ')}` : '');
    await sendMessage(systemIdentity(ctx, 'improvement-digest'), { to: ['human'], summary: digest.headline, body });
  } catch (e) {
    console.warn(`[improvement-digest] inbox broadcast skipped: ${e instanceof Error ? e.message : e}`);
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
  const maxPerRun = Number(process.env.PAPERCUSP_IMPROVEMENT_MAX_PER_RUN ?? 1) || 1;
  const maxAttempts = Number(process.env.PAPERCUSP_IMPROVEMENT_MAX_ATTEMPTS ?? 0) || undefined;

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
