/**
 * resolve-core.ts — the verify-and-mark-done BACK-EDGE of the self-improvement
 * loop (close-the-self-improvement-loop-2026-06-05 D-001).
 *
 * Before this existed the loop never closed: the implement routine dispatched a
 * bug to the runner, the runner fixed it, and **nothing marked it resolved** — so
 * the next cadence tick re-dispatched the same already-fixed bug, forever. This
 * module is the missing edge. The implement worker calls it (via the
 * `improvements:resolve` tool) when it finishes a dispatched item:
 *
 *   - `fixed`         — the fix is implemented AND VERIFIED (tests run + green).
 *                       Records the verification evidence as a comment and marks
 *                       the issue `resolved` → it leaves the open queue for good.
 *   - `could-not-fix` — the worker tried and failed. Releases the claim so a
 *                       later run can retry; when the dispatch-attempt counter
 *                       has hit `maxAttempts`, ALSO routes the item to a human
 *                       (`payload.needsHuman`) so an unfixable bug can't ping-pong
 *                       in the auto lane forever.
 *   - `needs-human`   — the worker judged the fix touches a protected surface
 *                       (operator-core safety / deploy machinery / a migration)
 *                       or genuinely needs human judgment. Releases the claim +
 *                       sets `payload.needsHuman` → the policy forces the human
 *                       tier from then on.
 *
 * Deps are injectable so every branch is unit-testable without PG.
 */

import {
  getIssue,
  setIssueState,
  commentIssue,
  releaseIssue,
  mergeIssuePayload,
  type EngineerIssue,
  type IssueState,
} from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import { initializeIdeaLifecycle, updateIdeaLifecycle, type IdeaLifecyclePayload } from './lifecycle';
import { closeDispatchesForItem } from './dispatch-ledger';

export type ResolveOutcome = 'fixed' | 'could-not-fix' | 'needs-human';

/** Default cap on auto-implement dispatch attempts before an item routes to a human. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface ResolveImprovementInput {
  id: string;
  outcome: ResolveOutcome;
  /** What happened — for `fixed`, the verification evidence (what changed + how it was verified). */
  summary: string;
  /** The test command(s) run + their result — REQUIRED for `fixed` (the "verified" in verify-and-mark-done). */
  testsRun?: string;
  /** Commit / branch the fix landed on (it still rides the release gate). */
  commit?: string;
  /** Who is resolving (the worker's identity). */
  by?: string;
  /** Attempt cap for the could-not-fix → needs-human graduation (default 3). */
  maxAttempts?: number;
}

export interface ResolveImprovementResult {
  ok: boolean;
  id: string;
  outcome?: ResolveOutcome;
  /** The issue's lifecycle state after the resolve. */
  state?: IssueState;
  /** True when a could-not-fix exhausted its attempts and was routed to a human. */
  routedToHuman?: boolean;
  error?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface ResolveDeps {
  getIssue: (id: string) => Promise<EngineerIssue | null>;
  setIssueState: (id: string, state: IssueState, by?: string) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
  releaseIssue: (id: string) => Promise<EngineerIssue | null>;
  mergeIssuePayload: (id: string, patch: Record<string, unknown>) => Promise<EngineerIssue | null>;
  /** Dispatch-ledger back-edge (consume-edges P-010 / B-04): drive the item's
   *  open improvement_dispatches rows terminal. Optional for older callers;
   *  default = dispatch-ledger's closeDispatchesForItem. */
  closeDispatches?: (itemId: string, opts: { outcome: ResolveOutcome; by?: string }) => Promise<number>;
}

const defaultDeps: ResolveDeps = {
  getIssue,
  setIssueState,
  commentIssue,
  releaseIssue,
  mergeIssuePayload,
  closeDispatches: closeDispatchesForItem,
};

function attemptsOf(issue: EngineerIssue): number {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  return typeof p.implementAttempts === 'number' ? p.implementAttempts : 0;
}

function lifecycleOf(issue: EngineerIssue): IdeaLifecyclePayload | null {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  const l = p.ideaLifecycle;
  return l && typeof l === 'object' && typeof (l as { state?: unknown }).state === 'string'
    ? (l as IdeaLifecyclePayload)
    : null;
}

export async function resolveImprovement(
  input: ResolveImprovementInput,
  deps: ResolveDeps = defaultDeps,
): Promise<ResolveImprovementResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return { ok: false, id: input.id, error: `issue ${input.id} not found` };

  const by = input.by ?? 'improvement-runner';

  // Drive the item's open dispatch-ledger rows terminal (P-010 / B-04) — called
  // on every SUCCESSFUL resolve path below. Best-effort: a ledger failure must
  // never fail the resolve itself (the orphan collector sweeps stragglers).
  const closeLedger = async () => {
    try {
      await (deps.closeDispatches ?? closeDispatchesForItem)(input.id, { outcome: input.outcome, by });
    } catch (e) {
      console.warn(`[improvements:resolve] dispatch-ledger close failed for ${input.id}:`, e instanceof Error ? e.message : e);
    }
  };

  if (issue.state !== 'open' && input.outcome === 'fixed') {
    // Idempotent: resolving an already-resolved item is a no-op success (a
    // re-fired runner must not error out on the second resolve). Still close any
    // open ledger rows — a manually-resolved item must not strand one for the
    // orphan collector to false-positive on.
    await closeLedger();
    return { ok: true, id: input.id, outcome: 'fixed', state: issue.state };
  }

  if (input.outcome === 'fixed') {
    if (!input.testsRun?.trim()) {
      return {
        ok: false,
        id: input.id,
        error: 'outcome "fixed" requires testsRun — a fix is only resolved when VERIFIED (run the tests, then resolve with the evidence)',
      };
    }
    const evidence =
      `✅ Auto-implement resolved (verified):\n${input.summary}\n\n` +
      `Tests: ${input.testsRun}` +
      (input.commit ? `\nLanded: ${input.commit} (rides the release gate)` : '');
    await deps.commentIssue(input.id, evidence, by);
    const updated = await deps.setIssueState(input.id, 'resolved', by);
    // Advance the idea lifecycle to 'applied' (self-learning P-031) — the decay
    // sweep then grades it verified/recurred from signature recurrence (P-013).
    // Permissive on the prior state: a legacy item without a lifecycle gets one
    // here so it still enters the decay pipeline.
    await deps.mergeIssuePayload(input.id, {
      ideaLifecycle: updateIdeaLifecycle(lifecycleOf(issue) ?? initializeIdeaLifecycle(), 'applied'),
    });
    await closeLedger();
    return { ok: true, id: input.id, outcome: 'fixed', state: updated?.state ?? 'resolved' };
  }

  if (input.outcome === 'needs-human') {
    await deps.commentIssue(input.id, `⤴ Routed to a human by the implement worker:\n${input.summary}`, by);
    await deps.mergeIssuePayload(input.id, { needsHuman: true });
    await deps.releaseIssue(input.id);
    await closeLedger();
    return { ok: true, id: input.id, outcome: 'needs-human', state: 'open', routedToHuman: true };
  }

  // could-not-fix: release for a later retry; exhausted attempts → human.
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempts = attemptsOf(issue);
  const exhausted = attempts >= maxAttempts;
  await deps.commentIssue(
    input.id,
    `✗ Auto-implement attempt ${attempts || '?'} failed:\n${input.summary}` +
      (exhausted ? `\n\nRetries exhausted (${attempts}/${maxAttempts}) — routing to a human.` : ''),
    by,
  );
  if (exhausted) await deps.mergeIssuePayload(input.id, { needsHuman: true });
  await deps.releaseIssue(input.id);
  await closeLedger();
  return { ok: true, id: input.id, outcome: 'could-not-fix', state: 'open', routedToHuman: exhausted };
}

// ── Exhausted-without-resolve ⇒ needs-human (consume-edges P-012) ─────────────
//
// The paths above only run when a worker CALLS improvements:resolve. A worker
// that dies silently (SIGTERM, crash, never spawned) calls nothing — so an item
// whose dispatch attempts exhaust through the stale-claim cycle stays stranded
// in the auto lane forever: never dispatchable again (the attempts cap), never
// routed to a human (only an explicit could-not-fix/needs-human resolve did
// that). This is the flip that catches the silent-death case: the implement
// routine calls it for every attempts-exhausted item still missing `needsHuman`.

export interface ExhaustedFlipInput {
  id: string;
  /** Dispatch attempts recorded so far (for the explanatory comment). */
  attempts?: number;
  /** The cap the attempts exhausted against (default DEFAULT_MAX_ATTEMPTS). */
  maxAttempts?: number;
  /** Who is flipping (default 'improvement-implement' — the routine). */
  by?: string;
}

export interface ExhaustedFlipResult {
  ok: boolean;
  id: string;
  /** True when this call routed the item to the human tier. */
  flipped: boolean;
  /** Why nothing was flipped (already-human / not-open / not-found). */
  reason?: string;
}

/**
 * Route an attempts-exhausted item with NO resolve ever recorded to the human
 * tier: explanatory comment + `payload.needsHuman` + release the (stale) claim.
 * Idempotent — an item already flagged, resolved, or missing is a no-op, so the
 * routine can call it every tick for whatever planImplementRun reports exhausted.
 */
export async function routeExhaustedImprovementToHuman(
  input: ExhaustedFlipInput,
  deps: ResolveDeps = defaultDeps,
): Promise<ExhaustedFlipResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return { ok: false, id: input.id, flipped: false, reason: `issue ${input.id} not found` };
  if (issue.state !== 'open') return { ok: true, id: input.id, flipped: false, reason: 'not open' };
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  if (p.needsHuman === true) return { ok: true, id: input.id, flipped: false, reason: 'already routed to a human' };

  const by = input.by ?? 'improvement-implement';
  const attempts = input.attempts ?? attemptsOf(issue);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  await deps.commentIssue(
    input.id,
    `⤴ Auto-implement attempts exhausted with NO resolve ever recorded (${attempts}/${maxAttempts} dispatches) — ` +
      `the worker(s) died without calling improvements:resolve (silent worker death). ` +
      `Routing to a human; this item will not auto-dispatch again.`,
    by,
  );
  await deps.mergeIssuePayload(input.id, { needsHuman: true });
  await deps.releaseIssue(input.id);
  return { ok: true, id: input.id, flipped: true };
}
