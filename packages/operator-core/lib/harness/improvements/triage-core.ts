/**
 * triage-core.ts — the PERSISTENCE edge of Queen-turn triage
 * (learning-system-audit-improvements-2026-06-09 P-010/P-011; self-learning P-020).
 *
 * Before this existed, `improvements:triage` computed a decision and returned it
 * as JSON — and threw it away (the literal "(In a real implementation, this would
 * write to the DB)" gap). This module is the missing write:
 *
 *   - `applyTriageDecision` — record ONE decision durably on the item:
 *       · writes `payload.ideaLifecycle` → state 'triaged' + decision + reason
 *         (+ ideaType from the classifier), validated against the state machine;
 *       · `reject` ALSO closes the issue with `payload.decidedReason`, so a
 *         rejected idea leaves the open queue AND the "already decided: <reason>"
 *         recall fires on the next same-signature capture (queue-as-memory, D-004).
 *   - `selectUntriaged` — the pure batch picker the scheduled
 *     `system:improvement-triage` routine uses: open items with no lifecycle yet
 *     (or sitting in 'open'/'recurred'), highest digest score first.
 *
 * Deps are injectable so every branch is unit-testable without PG (the
 * resolve-core pattern).
 */

import {
  getIssue,
  setIssueState,
  commentIssue,
  mergeIssuePayload,
  type EngineerIssue,
} from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import type { ScoredItem } from './digest';
import type { TriageDecision } from './triage';
import { classifyIdeaType } from './triage';
import { issueToCandidate } from './read-items';
import {
  initializeIdeaLifecycle,
  updateIdeaLifecycle,
  isValidTransition,
  type IdeaLifecyclePayload,
} from './lifecycle';

export interface ApplyTriageInput {
  id: string;
  decision: TriageDecision;
  reason: string;
  /** Who decided ('Queen', 'improvement-triage' for the scheduled pass, a human id). */
  by?: string;
  /** Write an audit comment on the issue (default true; the scheduled batch
   *  passes false so a 25-item pass doesn't spray 25 thread posts). */
  comment?: boolean;
}

export interface ApplyTriageResult {
  ok: boolean;
  id: string;
  decision?: TriageDecision;
  lifecycle?: IdeaLifecyclePayload;
  /** True when decision='reject' closed the issue (it left the open queue). */
  closed?: boolean;
  error?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface TriageCoreDeps {
  getIssue: (id: string) => Promise<EngineerIssue | null>;
  setIssueState: (id: string, state: 'open' | 'resolved' | 'closed', by?: string) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
  mergeIssuePayload: (id: string, patch: Record<string, unknown>) => Promise<EngineerIssue | null>;
}

const defaultDeps: TriageCoreDeps = { getIssue, setIssueState, commentIssue, mergeIssuePayload };

function lifecycleOf(issue: EngineerIssue): IdeaLifecyclePayload | null {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  const l = p.ideaLifecycle;
  return l && typeof l === 'object' && typeof (l as { state?: unknown }).state === 'string'
    ? (l as IdeaLifecyclePayload)
    : null;
}

export async function applyTriageDecision(
  input: ApplyTriageInput,
  deps: TriageCoreDeps = defaultDeps,
): Promise<ApplyTriageResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return { ok: false, id: input.id, error: `issue ${input.id} not found` };
  if (issue.state !== 'open') {
    return { ok: false, id: input.id, error: `issue ${input.id} is ${issue.state} — only OPEN items are triaged` };
  }

  // Legacy items (captured before the lifecycle landed) start at 'open' here.
  const current = lifecycleOf(issue) ?? initializeIdeaLifecycle();
  if (!isValidTransition(current.state, 'triaged')) {
    return {
      ok: false,
      id: input.id,
      error: `cannot triage from lifecycle state '${current.state}' (already ${current.state})`,
    };
  }

  // Full-fidelity classification (D-005): the candidate view carries paths +
  // watchdogKey + kind, which the taxonomy keys off — never a scope-only call.
  const ideaType = classifyIdeaType(issueToCandidate(issue)).type;
  const lifecycle = updateIdeaLifecycle(current, 'triaged', {
    triageDecision: input.decision,
    triageReason: input.reason,
    ideaType,
  });

  const by = input.by ?? 'improvement-triage';
  const patch: Record<string, unknown> = { ideaLifecycle: lifecycle };
  // Reject = a DECIDED idea: record the durable reason for the recall matcher
  // ("already decided: <reason>") and close it so it leaves the open queue.
  if (input.decision === 'reject') patch.decidedReason = input.reason;
  await deps.mergeIssuePayload(input.id, patch);

  if (input.comment !== false) {
    await deps.commentIssue(input.id, `Triage (${by}): ${input.decision} — ${input.reason}`, by);
  }

  let closed = false;
  if (input.decision === 'reject') {
    await deps.setIssueState(input.id, 'closed', by);
    closed = true;
  }

  // Push the Learning tab's improvements feed (lazy + fire-and-forget — the
  // capture-core pattern; a missing SSE bus is a no-op).
  void import('../../sync-sse')
    .then((m) => m.notifySyncInvalidate('learning.improvements'))
    .catch(() => {});

  return { ok: true, id: input.id, decision: input.decision, lifecycle, closed };
}

/**
 * Pure batch picker for the scheduled triage pass: OPEN scored items whose
 * lifecycle has not been triaged yet ('open', 'recurred', or no lifecycle at
 * all — legacy captures), highest score first, capped at `max`.
 */
export function selectUntriaged(scored: ScoredItem[], max: number): ScoredItem[] {
  if (max <= 0) return [];
  return scored
    .filter((i) => {
      const s = i.ideaLifecycleState;
      return s === undefined || s === 'open' || s === 'recurred';
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
