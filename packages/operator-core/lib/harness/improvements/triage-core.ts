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

import { getIssue, setIssueState, commentIssue, mergeIssuePayload, type EngineerIssue } from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import type { ScoredItem } from './digest';
import type { TriageDecision } from './triage';
import { classifyIdeaType, extractCitedIds } from './triage';
import { issueToCandidate } from './read-items';
import {
  initializeIdeaLifecycle,
  updateIdeaLifecycle,
  isValidTransition,
  type IdeaLifecyclePayload,
} from './lifecycle';
import { trackDetached } from '../../detached-imports';
import { enterAgentReview } from './agent-review';
import { ISSUE_TERMINAL_STATUSES } from '../../work-item-blocking';

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
  /** Present when an evidence guard downgraded an incoming place→gate.
   *  `requestedDecision` is what the caller asked for. Unresolved and same-role
   *  citations are integrity failures; stale citations are the older staleness
   *  guard's contradiction signal. */
  evidenceDowngrade?: {
    requestedDecision: TriageDecision;
    citedIds: string[];
    staleIds: string[];
    unresolvedIds?: string[];
    circularIds?: string[];
  };
  error?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface TriageCoreDeps {
  getIssue: (id: string) => Promise<EngineerIssue | null>;
  setIssueState: (
    id: string,
    state: 'open' | 'resolved' | 'closed',
    by?: string,
    completionRef?: string,
    opts?: { skipCompletionGate?: boolean },
  ) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
  mergeIssuePayload: (
    id: string,
    patch: Record<string, unknown>,
    opts?: { unset?: readonly string[] },
  ) => Promise<EngineerIssue | null>;
  enterAgentReview: typeof enterAgentReview;
}

const defaultDeps: TriageCoreDeps = {
  getIssue,
  setIssueState,
  commentIssue,
  mergeIssuePayload,
  enterAgentReview,
};

export type ReopenRejectedTriageResult = 'reopened' | 'already_open' | 'not_found' | 'source_changed';

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Restore the exact open improvement state that preceded a bulk reject. */
export async function reopenRejectedTriageForCompensation(
  input: {
    id: string;
    expectedReason: string;
    priorIdeaLifecycle: unknown | null;
    priorDecidedReason: string | null;
  },
  deps: TriageCoreDeps = defaultDeps,
): Promise<ReopenRejectedTriageResult> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return 'not_found';
  const payload = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  const currentLifecycle = payload.ideaLifecycle ?? null;
  const currentReason = typeof payload.decidedReason === 'string' ? payload.decidedReason : null;
  const priorAlreadyRestored =
    issue.state === 'open' &&
    sameJson(currentLifecycle, input.priorIdeaLifecycle) &&
    currentReason === input.priorDecidedReason;
  if (priorAlreadyRestored) return 'already_open';

  const isBulkReject =
    (issue.state === 'closed' || issue.state === 'open') &&
    currentReason === input.expectedReason &&
    currentLifecycle !== null &&
    typeof currentLifecycle === 'object' &&
    (currentLifecycle as { triageDecision?: unknown }).triageDecision === 'reject';
  if (!isBulkReject) return 'source_changed';

  // State first: if the payload restore fails, a retry sees the still-stamped
  // reject on an open row and finishes it. The opposite order would remove the
  // compare-and-set evidence while leaving the row closed and unretryable.
  if (issue.state !== 'open') {
    const reopened = await deps.setIssueState(input.id, 'open', 'autonomy-revert', undefined, {
      skipCompletionGate: true,
    });
    if (!reopened) return 'source_changed';
  }

  const patch: Record<string, unknown> = {};
  const unset: string[] = [];
  if (input.priorIdeaLifecycle === null) unset.push('ideaLifecycle');
  else patch.ideaLifecycle = input.priorIdeaLifecycle;
  if (input.priorDecidedReason === null) unset.push('decidedReason');
  else patch.decidedReason = input.priorDecidedReason;
  const restored = await deps.mergeIssuePayload(input.id, patch, { unset });
  return restored ? 'reopened' : 'source_changed';
}

/**
 * Evidence-staleness pre-check (EI-18696839552593260): a Scout-idea batch filed
 * 12 near-duplicate ideas, each citing a slightly different subset of the same
 * underlying evidence cluster, and every one of those cited items ALREADY
 * carried a terminal state + completion ref that contradicted the idea's own
 * premise — a single cheap check would have caught every one before it was
 * auto-triaged 'place' and burned a claim+investigate+reject cycle.
 *
 * Best-effort + narrow by design: a lookup failure or an idea citing nothing
 * never blocks anything (returns stale:false); it only ever recommends a
 * place→gate DOWNGRADE (never a reject — mirrors the scheduled triage pass's
 * existing "never reject automatically" conservatism, improvement-actions.ts),
 * and only when EVERY citation resolves to terminal-with-evidence. An
 * unresolved citation keeps the premise unverified rather than being silently
 * ignored; citation integrity is enforced by the companion inspection below.
 */
type EvidenceIssue = Pick<EngineerIssue, 'id' | 'title' | 'body'> & { payload?: EngineerIssue['payload'] };

interface EvidenceCitationInspection {
  citedIds: string[];
  staleIds: string[];
  unresolvedIds: string[];
  circularIds: string[];
  lookupFailedIds: string[];
  stale: boolean;
}

function sourceRoleOf(issue: { payload?: EngineerIssue['payload'] }): string | undefined {
  const payload = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  return typeof payload.sourceRole === 'string' ? payload.sourceRole : undefined;
}

/**
 * Resolve every cited work-item before a place decision can treat the citations
 * as evidence. A missing row is a concrete integrity failure; a resolver error
 * remains fail-open because transient datastore blindness is not proof of a
 * missing incident. Same-role generated ideas are circular evidence rather than
 * incidents, even when they happen to be terminal.
 */
async function inspectEvidenceCitations(
  issue: EvidenceIssue,
  deps: Pick<TriageCoreDeps, 'getIssue'>,
): Promise<EvidenceCitationInspection> {
  const citedIds = extractCitedIds(`${issue.title ?? ''} ${issue.body ?? ''}`).filter((id) => id !== issue.id);
  const staleIds: string[] = [];
  const unresolvedIds: string[] = [];
  const circularIds: string[] = [];
  const lookupFailedIds: string[] = [];
  const resolvedIds: string[] = [];
  const sourceRole = sourceRoleOf(issue);

  for (const id of citedIds) {
    let cited: EngineerIssue | null = null;
    try {
      cited = await deps.getIssue(id);
    } catch {
      lookupFailedIds.push(id);
      continue; // best-effort — a lookup failure never blocks the decision
    }
    if (!cited) {
      unresolvedIds.push(id);
      continue;
    }
    resolvedIds.push(id);
    if (sourceRole && sourceRole !== 'human' && sourceRoleOf(cited) === sourceRole) {
      circularIds.push(id);
    }
    if (ISSUE_TERMINAL_STATUSES.has(cited.state) && cited.terminalCompletionRef) {
      staleIds.push(id);
    }
  }

  // A stale verdict is meaningful only when the complete citation set was
  // resolved. Otherwise the missing/failed lookup is itself the uncertainty.
  const stale =
    resolvedIds.length > 0 &&
    unresolvedIds.length === 0 &&
    lookupFailedIds.length === 0 &&
    staleIds.length === resolvedIds.length;
  return { citedIds, staleIds, unresolvedIds, circularIds, lookupFailedIds, stale };
}

export async function evidenceStalenessCheck(
  issue: EvidenceIssue,
  deps: Pick<TriageCoreDeps, 'getIssue'>,
): Promise<{ stale: boolean; citedIds: string[]; staleIds: string[] }> {
  const check = await inspectEvidenceCitations(issue, deps);
  return { stale: check.stale, citedIds: check.citedIds, staleIds: check.staleIds };
}

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
  // The improvement lifecycle is independent from work-item completion. A routed
  // idea can remain untriaged after its backing work-item reaches any terminal
  // status, so preserve that work-item status while recording the late triage.
  // Non-terminal, non-open states still indicate an item actively owned by another
  // lifecycle (wip/blocked/needs-human) and remain ineligible here.
  const terminalBacking = ISSUE_TERMINAL_STATUSES.has(issue.state);
  if (issue.state !== 'open' && !terminalBacking) {
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

  // Evidence-staleness guard (EI-18696839552593260): a 'place' recommendation whose
  // OWN cited evidence is already terminal-with-completion-ref gets downgraded to
  // 'gate' before it ever reaches the auto-implement lane. Best-effort — never
  // throws, never touches a non-'place' decision.
  let decision: TriageDecision = input.decision;
  let reason = input.reason;
  let evidenceDowngrade: ApplyTriageResult['evidenceDowngrade'];
  if (decision === 'place') {
    try {
      const check = await inspectEvidenceCitations(issue, deps);
      const integrityFailure = check.unresolvedIds.length > 0 || check.circularIds.length > 0;
      if (check.stale || integrityFailure) {
        evidenceDowngrade = {
          requestedDecision: decision,
          citedIds: check.citedIds,
          staleIds: check.staleIds,
          ...(check.unresolvedIds.length ? { unresolvedIds: check.unresolvedIds } : {}),
          ...(check.circularIds.length ? { circularIds: check.circularIds } : {}),
        };
        decision = 'gate';
        const guardReasons: string[] = [];
        if (check.unresolvedIds.length) {
          guardReasons.push(
            `EVIDENCE-INTEGRITY GUARD (EI-19450720466036446): cited item(s) ` +
              `(${check.unresolvedIds.join(', ')}) did not resolve to work items`,
          );
        }
        if (check.circularIds.length) {
          guardReasons.push(
            `EVIDENCE-INTEGRITY GUARD (EI-19450720466036446): same-role generated idea(s) ` +
              `(${check.circularIds.join(', ')}) are circular evidence, not incident records`,
          );
        }
        if (check.stale) {
          guardReasons.push(
            `EVIDENCE-STALENESS GUARD (EI-18696839552593260): every cited item ` +
              `(${check.staleIds.join(', ')}) is already resolved/closed with a completion ref; this idea's ` +
              `premise may already be contradicted by its own cited evidence`,
          );
        }
        reason =
          `${input.reason} — ${guardReasons.join('; ')}. Downgraded place→gate for ` +
          `human/Queen re-verification before auto-implementing.`;
      }
    } catch {
      // best-effort — a guard failure never blocks a normal triage decision
    }
  }

  // Full-fidelity classification (D-005): the candidate view carries paths +
  // watchdogKey + kind, which the taxonomy keys off — never a scope-only call.
  const ideaType = classifyIdeaType(issueToCandidate(issue)).type;
  const lifecycle = updateIdeaLifecycle(current, 'triaged', {
    triageDecision: decision,
    triageReason: reason,
    ideaType,
  });

  const by = input.by ?? 'improvement-triage';
  const patch: Record<string, unknown> = { ideaLifecycle: lifecycle };
  // Reject = a DECIDED idea: record the durable reason for the recall matcher
  // ("already decided: <reason>") and close it so it leaves the open queue.
  if (decision === 'reject') patch.decidedReason = reason;
  await deps.mergeIssuePayload(input.id, patch);

  // A triage gate is review work, not an owner-capability escalation. Enrollment is
  // idempotent: an already-pending item stays in the same review round, while strict
  // typed owner actions and remote-owned rows remain on their existing lanes.
  if (decision === 'gate') {
    await deps.enterAgentReview({ id: input.id, submittedBy: by });
  }

  if (input.comment !== false) {
    await deps.commentIssue(input.id, `Triage (${by}): ${decision} — ${reason}`, by);
  }

  let closed = false;
  if (decision === 'reject' && !terminalBacking) {
    // Completion-integrity gate (WI-1403, contract C-1): a triage reject is a genuine,
    // reasoned DECISION by a principal (`by`) — the durable rejection reason IS the
    // completion evidence, so it carries a real completionRef rather than a skip.
    await deps.setIssueState(input.id, 'closed', by, `Triage decision: reject — ${reason}`);
    closed = true;
  }

  // Push the Learning tab's improvements feed (lazy + fire-and-forget — the
  // capture-core pattern; a missing SSE bus is a no-op).
  void trackDetached(import('../../sync-sse'))
    .then((m) =>
      Promise.all([
        m.notifySyncInvalidate('learning.improvements'),
        m.notifySyncInvalidate('learning.improvements.summary'),
      ]),
    )
    .catch(() => {});
  // Push-on-write for the Health tab's improvements panel
  // (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007) —
  // same lazy fire-and-forget discipline as the invalidate above.
  void trackDetached(import('../../system-health/compute'))
    .then((m) => m.refreshHealthPanel('improvements'))
    .catch(() => {});

  return { ok: true, id: input.id, decision, lifecycle, closed, ...(evidenceDowngrade ? { evidenceDowngrade } : {}) };
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
