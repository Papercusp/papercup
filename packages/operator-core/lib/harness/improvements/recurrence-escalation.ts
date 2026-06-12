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
 *     exactly what belongs in the shared knowledge layer — AND stages one
 *     learning-pack item CANDIDATE (consume-edges P-032 / brief B-11): a draft
 *     row in lib/learning-packs/candidates the OWNER reviews in the Learnings
 *     view; adoption materializes it into the fleet-lessons pack, never a hive
 *     pool. Identity-file/curator promotion (the full P-052) stays future work.
 *
 * Pure planner + thin glue (the standard seam split). All actions are capped and
 * idempotent: severity bumps stop at major, gym routing skips already-routed,
 * promotion captures dedup via the normal search-first capture core, candidate
 * staging dedups structurally (UNIQUE per signature) + caps the pending queue.
 */

import { updateIssue, commentIssue } from '../../issues-engineer';
import type { ImprovementCandidate, ImprovementSeverity } from './policy';
import { readImprovementItems } from './read-items';
import { signatureRecurrence, type SignatureRecurrence } from './digest';
import { classifyIdeaType } from './triage';
import { applyTriageDecision, type ApplyTriageInput, type ApplyTriageResult } from './triage-core';
import { captureImprovement, type CaptureImprovementInput, type CaptureImprovementResult } from './capture-core';
import {
  stageLearningPackCandidate,
  type StageCandidateInput,
  type StageCandidateResult,
} from '../../learning-packs/candidates';

export const RECURRENCE_ESCALATION_THRESHOLD = 3;

/** Cap on the draft-lesson body staged with a candidate (owner edits anyway). */
export const CANDIDATE_DRAFT_MAX_CHARS = 700;

export type EscalationAction =
  | { kind: 'escalate-severity'; id: string; from: ImprovementSeverity; to: 'major'; signature: string; count: number }
  | { kind: 'route-gym'; id: string; signature: string; count: number; reason: string }
  | {
      kind: 'suggest-promotion';
      signature: string;
      scopes: string[];
      count: number;
      sampleTitle: string;
      /** Member item ids, newest-first — candidate provenance (P-032). */
      sourceItemIds: string[];
      /** Draft lesson body for the staged candidate (newest member's body, capped). */
      draftText: string;
    };

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
      const newestBody = members.find((m) => m.body?.trim())?.body?.trim();
      const draft = newestBody ?? members[0].title;
      actions.push({
        kind: 'suggest-promotion',
        signature: sig.signature,
        scopes,
        count: sig.count,
        sampleTitle: members[0].title,
        sourceItemIds: members.map((m) => m.id),
        draftText:
          draft.length > CANDIDATE_DRAFT_MAX_CHARS ? `${draft.slice(0, CANDIDATE_DRAFT_MAX_CHARS - 1)}…` : draft,
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

    // D-005 taxonomy (consume-edges P-021): the gym-A/B-able class is
    // 'process-prompt' — the gym can A/B a prompt variant, not a code bug
    // (chronic code-bugs get the severity escalation above instead).
    const ideaType = classifyIdeaType(target).type;
    const alreadyGym = target.ideaLifecycle?.triageDecision === 'gym';
    const triageable =
      !target.ideaLifecycle ||
      ['open', 'triaged', 'recurred'].includes(target.ideaLifecycle.state);
    if (ideaType === 'process-prompt' && !alreadyGym && triageable && actions.length < maxActions) {
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
  /** Learning-pack candidates staged for owner review (P-032 — fleet→pack edge). */
  candidatesStaged: number;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface EscalationDeps {
  readItems: () => Promise<ImprovementCandidate[]>;
  updateIssue: (id: string, patch: { severity: 'major'; by: string }) => Promise<unknown>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<unknown>;
  applyTriage: (input: ApplyTriageInput) => Promise<ApplyTriageResult>;
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  stageCandidate: (input: StageCandidateInput) => Promise<StageCandidateResult>;
}

const defaultDeps: EscalationDeps = {
  readItems: () => readImprovementItems({}),
  updateIssue: (id, patch) => updateIssue(id, patch),
  commentIssue,
  applyTriage: applyTriageDecision,
  capture: captureImprovement,
  stageCandidate: stageLearningPackCandidate,
};

export async function runRecurrenceEscalation(
  opts: PlanEscalationOpts = {},
  deps: EscalationDeps = defaultDeps,
): Promise<EscalationResult> {
  const all = await deps.readItems();
  const actions = planRecurrenceEscalation(all, opts);
  const result: EscalationResult = { escalated: 0, gymRouted: 0, promotionsSuggested: 0, candidatesStaged: 0 };

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

      // P-032 (B-11): the same cross-scope recurrence also stages ONE
      // learning-pack candidate for the owner's review queue. Best-effort —
      // a staging failure (PG blip) must never abort the escalation pass;
      // the planner re-emits the action next tick and the structural dedup
      // makes the retry safe.
      try {
        const staged = await deps.stageCandidate({
          signature: a.signature,
          title: a.sampleTitle,
          draftText: a.draftText,
          scopes: a.scopes,
          recurrenceCount: a.count,
          sourceItemIds: a.sourceItemIds,
        });
        if (staged.staged) result.candidatesStaged += 1;
      } catch (e) {
        console.warn(
          '[recurrence-escalation] candidate staging failed:',
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
  return result;
}
