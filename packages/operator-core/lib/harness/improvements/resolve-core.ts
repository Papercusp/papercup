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
}

const defaultDeps: ResolveDeps = { getIssue, setIssueState, commentIssue, releaseIssue, mergeIssuePayload };

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
  if (issue.state !== 'open' && input.outcome === 'fixed') {
    // Idempotent: resolving an already-resolved item is a no-op success (a
    // re-fired runner must not error out on the second resolve).
    return { ok: true, id: input.id, outcome: 'fixed', state: issue.state };
  }

  const by = input.by ?? 'improvement-runner';

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
    return { ok: true, id: input.id, outcome: 'fixed', state: updated?.state ?? 'resolved' };
  }

  if (input.outcome === 'needs-human') {
    await deps.commentIssue(input.id, `⤴ Routed to a human by the implement worker:\n${input.summary}`, by);
    await deps.mergeIssuePayload(input.id, { needsHuman: true });
    await deps.releaseIssue(input.id);
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
  return { ok: true, id: input.id, outcome: 'could-not-fix', state: 'open', routedToHuman: exhausted };
}
