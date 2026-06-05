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
 * top: the digest is a pure read; implement re-derives the same plan + re-fires
 * idempotently (the runner's own work-unit dedup + the release gate are the real
 * guards; a re-fire at most re-kicks the same bug).
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { loopbackFetch } from '../../loopback-fetch';
import { resolveLaunchTarget } from '../../blueprint/launch-blueprint';
import { readImprovementItems } from '../improvements/read-items';
import { buildDigest } from '../improvements/digest';
import { planImplementRun } from '../improvements/plan-implement';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import type { ScoredItem } from '../improvements/digest';

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
 * Default dispatch: kick a worker in the DEDICATED runner harness (D-006) with a
 * kickoff describing the bug. The runner implements + validates and the change
 * lands via the release gate (D-008). Fire-and-forget. (This path only ever runs
 * when an owner has flipped the flag AND configured the runner harness — see
 * planImplementRun's gates; until then it is unreachable.)
 */
const defaultFire: ImplementFireFn = async ({ runnerHarness, workspaceId, candidate }) => {
  // unify-agent-launches-as-blueprints D-002/D-003: the launch is DECLARATIVE — the
  // `implement` launch blueprint declares the role (decider worker); we resolve it
  // here instead of hardcoding `role=worker`. The risk-gate (`planImplementRun`:
  // flag ON, runner configured, kind=bug, cap) above stays the routine's concern.
  const { url } = await resolveLaunchTarget('implement', { installSlug: runnerHarness, workspaceId });
  await loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kickoff:
        `Auto-implement papercusp improvement ${candidate.id} (kind=bug): "${candidate.title}". ` +
        `Reproduce, fix with a regression test, keep it self/inline-sized. It lands via the release gate — ` +
        `if the fix would touch operator-core safety / the deploy machinery / a migration, STOP and escalate to a human.`,
      timeoutMs: 280_000,
    }),
  }).catch((e) => console.warn(`[improvement-implement] dispatch failed for ${candidate.id}: ${e instanceof Error ? e.message : e}`));
};

registerSystemAction('improvement-implement', async (ctx: SystemActionCtx) => {
  const items = await readImprovementItems({ state: 'open' });
  const flagEnabled = await getFlag(FLAGS.IMPROVEMENT_AUTO_IMPLEMENT, `routine:${ctx.installSlug}`);
  const runnerHarness = process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS || null;
  const maxPerRun = Number(process.env.PAPERCUSP_IMPROVEMENT_MAX_PER_RUN ?? 1) || 1;

  const plan = planImplementRun({ items, flagEnabled, runnerHarness, maxPerRun });
  if (plan.action !== 'dispatch') {
    console.log(`[improvement-implement] ${plan.action}: ${plan.message}`);
    return;
  }
  console.log(`[improvement-implement] ${plan.message}`);
  const fire = _fire ?? defaultFire;
  for (const candidate of plan.candidates) {
    await fire({ runnerHarness: runnerHarness as string, workspaceId: ctx.workspaceId, candidate });
  }
});
