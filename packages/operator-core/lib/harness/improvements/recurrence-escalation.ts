/**
 * recurrence-escalation.ts — repeated pain becomes pressure
 * (learning-system-audit-improvements-2026-06-09 P-053 + the P-052 cross-scope half).
 *
 * Before this, a friction signature recurring over and over was just N rows the
 * digest counted — nothing changed because of the repetition. Three rules, run
 * on the triage cadence:
 *
 *   - **escalate-severity** (P-053): a signature seen ≥3 times whose newest OPEN
 *     item is still minor/nit gets bumped to major — recurrence IS severity
 *     evidence, and it un-stars the item from the per-source minor starvation.
 *   - **route-gym** (P-053): a recurring PROCESS-class item not already routed
 *     to the gym gets re-triaged decision='gym' — chronic process friction earns
 *     the positive A/B rail (D-003), not another round of recurrence-decay.
 *   - **suggest-promotion** (P-052 lite): a signature recurring across ≥2 DISTINCT
 *     scopes (operator + a harness, or two harnesses) files one kind=change
 *     capture proposing a shared lesson (insight/memory) — cross-Hive pain is
 *     exactly what belongs in the shared knowledge layer. Identity-file/curator
 *     promotion (the full P-052) stays future work.
 *
 * Pure planner + thin glue (the standard seam split). All actions are capped and
 * idempotent: severity bumps stop at major, gym routing skips already-routed,
 * promotion captures dedup via the normal search-first capture core.
 */

import { updateIssue, commentIssue } from '../../issues-engineer';
import type { ImprovementCandidate, ImprovementSeverity } from './policy';
import { readImprovementItems } from './read-items';
import { signatureRecurrence, type SignatureRecurrence } from './digest';
import { classifyIdeaType } from './triage';
import { applyTriageDecision, type ApplyTriageInput, type ApplyTriageResult } from './triage-core';
import { captureImprovement, type CaptureImprovementInput, type CaptureImprovementResult } from './capture-core';
import type { ScoredItem } from './digest';

export const RECURRENCE_ESCALATION_THRESHOLD = 3;

export type EscalationAction =
  | { kind: 'escalate-severity'; id: string; from: ImprovementSeverity; to: 'major'; signature: string; count: number }
  | { kind: 'route-gym'; id: string; signature: string; count: number; reason: string }
  | { kind: 'suggest-promotion'; signature: string; scopes: string[]; count: number; sampleTitle: string };

export interface PlanEscalationOpts {
  threshold?: number;
  maxActions?: number;
}

function newestOpenUnclaimed(members: ImprovementCandidate[]): ImprovementCandidate | undefined {
  return members
    .filter((m) => (m.state ?? 'open') === 'open' && !m.assignee)
    .sort((a, b) => Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0'))[0];
}

/** Pure: which recurring signatures warrant action? `all` spans all states. */
export function planRecurrenceEscalation(
  all: ImprovementCandidate[],
  opts: PlanEscalationOpts = {},
): EscalationAction[] {
  const threshold = opts.threshold ?? RECURRENCE_ESCALATION_THRESHOLD;
  const maxActions = opts.maxActions ?? 10;
  if (maxActions <= 0) return [];

  const byId = new Map(all.map((c) => [c.id, c]));
  const recurring: SignatureRecurrence[] = signatureRecurrence(all).filter((s) => s.count >= threshold);
  const actions: EscalationAction[] = [];

  for (const sig of recurring) {
    if (actions.length >= maxActions) break;
    const members = sig.ids.map((id) => byId.get(id)).filter((c): c is ImprovementCandidate => !!c);
    const target = newestOpenUnclaimed(members);

    // P-052 lite: cross-scope recurrence → propose a shared lesson (once per sig).
    const scopes = [...new Set(members.map((m) => m.scope))];
    if (scopes.length >= 2 && members[0]) {
      actions.push({
        kind: 'suggest-promotion',
        signature: sig.signature,
        scopes,
        count: sig.count,
        sampleTitle: members[0].title,
      });
    }

    if (!target) continue;

    const sev = target.severity ?? 'minor';
    if (sev === 'minor' || sev === 'nit') {
      actions.push({
        kind: 'escalate-severity',
        id: target.id,
        from: sev,
        to: 'major',
        signature: sig.signature,
        count: sig.count,
      });
    }

    const ideaType = classifyIdeaType({ scope: target.scope } as ScoredItem).type;
    const alreadyGym = target.ideaLifecycle?.triageDecision === 'gym';
    const triageable =
      !target.ideaLifecycle ||
      ['open', 'triaged', 'recurred'].includes(target.ideaLifecycle.state);
    if (ideaType === 'process' && !alreadyGym && triageable && actions.length < maxActions) {
      actions.push({
        kind: 'route-gym',
        id: target.id,
        signature: sig.signature,
        count: sig.count,
        reason: `friction signature recurred ${sig.count}× — chronic process pain earns gym A/B verification (P-053/D-003)`,
      });
    }
  }
  return actions.slice(0, maxActions);
}

export interface EscalationResult {
  escalated: number;
  gymRouted: number;
  promotionsSuggested: number;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface EscalationDeps {
  readItems: () => Promise<ImprovementCandidate[]>;
  updateIssue: (id: string, patch: { severity: 'major'; by: string }) => Promise<unknown>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<unknown>;
  applyTriage: (input: ApplyTriageInput) => Promise<ApplyTriageResult>;
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
}

const defaultDeps: EscalationDeps = {
  readItems: () => readImprovementItems({}),
  updateIssue: (id, patch) => updateIssue(id, patch),
  commentIssue,
  applyTriage: applyTriageDecision,
  capture: captureImprovement,
};

export async function runRecurrenceEscalation(
  opts: PlanEscalationOpts = {},
  deps: EscalationDeps = defaultDeps,
): Promise<EscalationResult> {
  const all = await deps.readItems();
  const actions = planRecurrenceEscalation(all, opts);
  const result: EscalationResult = { escalated: 0, gymRouted: 0, promotionsSuggested: 0 };

  for (const a of actions) {
    if (a.kind === 'escalate-severity') {
      await deps.updateIssue(a.id, { severity: 'major', by: 'recurrence-escalation' });
      await deps.commentIssue(
        a.id,
        `⇧ Severity escalated ${a.from}→major: this friction signature recurred ${a.count}× (P-053 — recurrence is severity evidence).`,
        'recurrence-escalation',
      );
      result.escalated += 1;
    } else if (a.kind === 'route-gym') {
      const r = await deps.applyTriage({
        id: a.id,
        decision: 'gym',
        reason: a.reason,
        by: 'recurrence-escalation',
        comment: true,
      });
      if (r.ok) result.gymRouted += 1;
    } else {
      const r = await deps.capture({
        title: `Cross-harness recurring friction — promote a shared lesson: ${a.sampleTitle}`,
        kind: 'change',
        severity: 'minor',
        body:
          `The friction signature \`${a.signature}\` recurred ${a.count}× across ${a.scopes.length} scopes ` +
          `(${a.scopes.join(', ')}). Cross-Hive pain belongs in the shared knowledge layer: write an ` +
          `agent-insights runbook or a harness-scoped memory:remember covering it, then resolve this item ` +
          `(P-052 — cross-harness lesson promotion).`,
        subTopic: 'lesson-promotion',
        sourceRole: 'system',
        dedupScope: 'open',
      });
      if (r.created) result.promotionsSuggested += 1;
    }
  }
  return result;
}
