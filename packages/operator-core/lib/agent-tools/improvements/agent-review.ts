/**
 * Public agent-review door over the existing work-item + Blender lifecycle.
 *
 * Identity is always caller-derived. Review pickup requires one concrete harness
 * and cannot select the submitter's own row; resubmission is accepted only from
 * the original submittedBy owner in the lifecycle core.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { AbortCompletionContext, AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import {
  adoptAgentReviewRevision,
  adoptNextAgentReviewRevision,
  claimAgentReview,
  claimNextAgentReview,
  resubmitAgentReview,
  correctAgentReview,
  readAgentReviewCorrectionBase,
  type AgentReviewClaimNextDiagnostics,
} from '../../harness/improvements/agent-review';
import { implementationAcceptanceProposalSchema, readAgentReviewState, agentReviewCorrectionSchema } from '../../harness/improvements/agent-review-policy';
import type { WorkItem } from '../../work-items';
import { asRecord, completedResultPayload } from '../abort-completion-payload';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';
import { getClaimSpecRecord } from '../../scheduler/claim-spec-store';

/** Read-only evidence handoff. Recorded references are leads, never reproduction proof. */
export function agentReviewEvidenceHandoff(workItem: WorkItem) {
  const payload = asRecord(workItem.payload) ?? {};
  const review = readAgentReviewState(payload);
  const sessionRefs = new Set<string>();
  const turnRefs = new Set<string>();
  const evidenceRefs = new Set<string>();
  let truncated = false;
  let visited = 0;
  const visit = (value: unknown, key = '', depth = 0): void => {
    if (++visited > 4000 || depth > 12) { truncated = true; return; }
    if (typeof value === 'string') {
      if (/^(sessionId|session_id|sourceSession|sourceSessionId|sessionRef)$/.test(key) && value && value !== 'self') sessionRefs.add(value);
      if (/^(ref|refs|evidenceRef|evidenceRefs)$/.test(key) && value) evidenceRefs.add(value);
      for (const match of value.matchAll(/session_turn:[a-z-]+:[a-zA-Z0-9_-]+:\d+/g)) turnRefs.add(match[0]);
      for (const match of value.matchAll(/(?:test_runs|thread-post|conversation|consult|attachment):[a-zA-Z0-9_./:#-]+/g)) evidenceRefs.add(match[0]);
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [name, entry] of Object.entries(value)) {
        // Receipts repeat source snapshots; the item/history is the evidence owner.
        if (name !== 'correctionReceipts') visit(entry, name, depth + 1);
      }
    }
  };
  visit(payload);
  visit(workItem.summary);
  const contextOutcomes = review?.correctionContext ?? [];
  return {
    filingIdentity: { createdBy: workItem.createdBy, submittedBy: review?.submittedBy ?? null,
      reporter: payload.reporter ?? null },
    source: { itemId: workItem.id, harness: workItem.harness, kind: workItem.kind,
      title: workItem.title, summary: workItem.summary },
    sessionRefs: [...sessionRefs],
    turnRefs: [...turnRefs],
    evidenceRefs: [...evidenceRefs],
    reportContext: payload.reportContext ?? null,
    correctionHistory: review?.correctionHistory ?? [],
    contextOutcomes,
    gaps: { transcript: sessionRefs.size || turnRefs.size ? 'recorded-reference-unread' : 'reference-not-recorded',
      consultation: contextOutcomes.filter(note => note.kind === 'consultation'),
      unresolved: contextOutcomes.filter(note => note.outcome !== 'available'),
      ...(truncated ? { referenceScan: 'bounded-read-full-item' } : {}) },
    investigation: {
      transcript: 'Use sessions:read with an exact session or session_turn reference; use sessions:search to locate an unrecorded source. Record missing or inaccessible outcomes explicitly.',
      consultation: 'After reading the available evidence, use consult:get_feedback for a concrete unresolved question. Record the conversation reference and actual answer or unavailable outcome.',
      history: { tool: 'work_items:get', args: { id: workItem.id, harness: workItem.harness, detail: true } },
      correction: 'Use correction-base, then correct with typed transcript/evidence/consultation notes. References and available context do not prove reproduction; canonical grading remains required.',
    },
  };
}

function gradeHandoff(workItem: WorkItem | null) {
  const review = workItem ? readAgentReviewState(workItem.payload) : null;
  if (review?.status !== 'pending') return {};
  return {
    ledgerIdeaId: review.ledgerIdeaId,
    gradeWith: { ideaId: review.ledgerIdeaId },
    reviewHandoff: agentReviewEvidenceHandoff(workItem!),
  };
}

/**
 * A review pickup/resubmission can commit before its handler returns past the dispatch
 * deadline. Name the returned work-item/round so callers do not retry an already-landed
 * mutation. Claim misses fail closed: claim-next may heal or reconcile rows while scanning,
 * and a directed claim can heal an own-node origin before a later refusal.
 */
export function agentReviewAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
  _context: AbortCompletionContext,
): AbortCompletionReceipt {
  const input = asRecord(args);
  const payload = completedResultPayload(result);
  const mode = input?.mode;
  if (!payload || payload.ok !== true || payload.mode !== mode) {
    return {
      status: 'recovery-incomplete',
      reason: 'improvements:agent-review result did not confirm the requested mode and success envelope',
      failures: ['missing-success-envelope'],
    };
  }

  if (mode === 'correction-base') return { status: 'not-recorded', reason: 'read-only-correction-base' };
  if (mode === 'correct') {
    const receipt = asRecord(payload.receipt);
    if (payload.corrected === true && receipt?.itemId === input?.id && receipt?.requestKey === input?.requestKey &&
      typeof receipt?.afterRevision === 'string' && /^correction-v1:[a-f0-9]{64}$/.test(receipt.afterRevision)) {
      return { status: 'recorded', effectRef: `improvements-agent-review:correct:${receipt.itemId}:${receipt.requestKey}:${receipt.afterRevision}` };
    }
    if (payload.corrected === false && typeof payload.reason === 'string') return { status: 'not-recorded', reason: payload.reason };
  }

  if (mode === 'claim' || mode === 'claim-next') {
    const workItem = asRecord(payload.workItem);
    const workItemId = workItem?.id;
    if (
      payload.claimed === true &&
      typeof workItemId === 'string' &&
      workItemId.trim().length > 0 &&
      (mode !== 'claim' || input?.id === workItemId)
    ) {
      return {
        status: 'recorded',
        effectRef: `improvements-agent-review:${mode}:${workItemId}`,
      };
    }

    // These two directed-claim exits happen before origin healing or any claim attempt.
    if (
      mode === 'claim' &&
      payload.claimed === false &&
      (payload.reason === 'not-found' || payload.reason === 'not-open')
    ) {
      return { status: 'not-recorded', reason: payload.reason };
    }

    return {
      status: 'recovery-incomplete',
      reason: 'claim refusal or queue miss may include lifecycle repair side effects and cannot safely invite a retry',
      failures: ['ambiguous-claim-outcome'],
    };
  }

  if (mode === 'adopt' || mode === 'adopt-next') {
    const workItemId = asRecord(payload.workItem)?.id;
    if (
      payload.adopted === true &&
      typeof workItemId === 'string' &&
      workItemId.trim().length > 0 &&
      (mode !== 'adopt' || input?.id === workItemId)
    ) {
      return { status: 'recorded', effectRef: `improvements-agent-review:${mode}:${workItemId}` };
    }
    // Every adoption refusal except 'state-changed' exits before or at a failed claim CAS,
    // so nothing landed; 'state-changed' may have claimed then released.
    const stateChanged = payload.reason === 'state-changed' ||
      (asRecord(payload.refusals)?.['state-changed'] ?? 0) !== 0;
    if (payload.adopted === false && !stateChanged) {
      return { status: 'not-recorded', reason: typeof payload.reason === 'string' ? payload.reason : 'no-adoptable-revision' };
    }
    return {
      status: 'recovery-incomplete',
      reason: 'adoption raced a lifecycle change and may have claimed then released the row',
      failures: ['ambiguous-adoption-outcome'],
    };
  }

  if (mode === 'resubmit') {
    const state = asRecord(payload.state);
    const itemId = input?.id;
    const round = state?.round;
    if (
      payload.resubmitted === true &&
      typeof itemId === 'string' &&
      itemId.trim().length > 0 &&
      state?.status === 'pending' &&
      typeof round === 'number' &&
      Number.isSafeInteger(round) &&
      round > 0
    ) {
      return {
        status: 'recorded',
        effectRef: `improvements-agent-review:resubmit:${itemId}:round:${round}`,
      };
    }
    if (payload.resubmitted === false && typeof payload.reason === 'string' && payload.reason.trim()) {
      return { status: 'not-recorded', reason: payload.reason };
    }
  }

  return {
    status: 'recovery-incomplete',
    reason: 'improvements:agent-review result did not identify its completed effect',
    failures: ['missing-effect-identity'],
  };
}

export default defineTool({
  name: 'improvements:agent-review',
  profile: 'engineer',
  abortCompletionReceipt: agentReviewAbortCompletionReceipt,
  description:
    'Claim peer-review work, read its exact correction base, or correct it as its assigned reviewer without the original filer participating. Material authors require a separate independent grader. Also supports legacy resubmit and orphan adoption; blender:grade-idea remains the grade authority.',
  guidance: {
    when: "Use mode:'claim' (id) for a directed review of one known pending item without consuming unrelated review work; mode:'claim-next' only to take the next pending change/feature, then grade its routed idea with blender:grade-idea. mode:'resubmit' after addressing feedback on your own revision-requested item. mode:'adopt' (id) or 'adopt-next' takes a content revision whose original submitter is provably gone, to revise and resubmit.",
    notWhen:
      'Do not use this to grade or approve — blender:grade-idea is the sole grade authority. Do not use ordinary scheduler:get_next for pending review work; that lane excludes it until approval.',
    chaining:
      "improvements:agent-review { mode:'claim', id } (directed) OR { mode:'claim-next' } → read reviewHandoff evidence (sessions:read/search; consult:get_feedback only for a concrete open question) → correction-base → correct {id,harness,requestKey,expectedRound,correctionRevision,correction}. Clarifications only append notes; material changes need a different grader. Record unavailable context as typed outcomes. Grade via gradeWith.ideaId + blender:grade-idea. Revision authors may resubmit with an unsealed acceptance proposal. Never write implementationReadiness via generic update.",
    seeAlso: [
      'blender:grade-idea (record the peer grade and drive approval/revision)',
      'work_items:get (read the claimed work and its checkpoint)',
      'work_items:comment (record review-relevant progress)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  // Raw JSON receipts also need a lossless twin for structured MCP clients.
  // A corrected handoff can exceed the separate model-facing text budget.
  result: z.record(z.string(), z.unknown()),
  args: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('correction-base'),
      id: z.string().min(1).max(80),
      harness: z.string().min(1).max(120).optional(),
    }).strict(),
    z.object({
      mode: z.literal('correct'),
      id: z.string().min(1).max(80),
      harness: z.string().min(1).max(120).optional(),
      requestKey: z.string().min(1).max(200),
      expectedRound: z.number().int().positive(),
      correctionRevision: z.string().regex(/^correction-v1:[a-f0-9]{64}$/),
      correction: agentReviewCorrectionSchema,
    }).strict(),
    z.object({
      mode: z.literal('claim'),
      id: z
        .string()
        .min(1)
        .max(80)
        .describe('The pending peer-review work-item id to claim without consuming another review candidate.'),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Harness containing the review item. Omit only when the session is already scoped to one concrete harness; 'all' and '*' are refused.",
        ),
    }),
    z.object({
      mode: z.literal('claim-next'),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Harness to review. Omit only when the session is already scoped to one concrete harness; 'all' and '*' are refused.",
        ),
    }),
    z.object({
      mode: z.literal('resubmit'),
      id: z
        .string()
        .min(1)
        .max(80)
        .describe("The revision-requested work-item id — yours, or an orphan whose submitter is gone."),
      acceptance: implementationAcceptanceProposalSchema.optional()
        .describe('Unsealed five-field proposal for this revision: problem, nonempty evidence, outcome, scope and completionCheck. Only independent review can seal it.'),
      reproduction: z
        .object({
          kind: z.enum(['failing-test', 'scripted-repro', 'current-build-observation']),
          ref: z.string().min(1).max(2000),
          buildSha: z.string().regex(/^[0-9a-f]{7,40}$/i),
        })
        .optional()
        .describe('Only for a bug claimed as reproduction validation: your current-build reproduction receipt. The next review round verifies it.'),
    }),
    z.object({
      mode: z.literal('adopt'),
      id: z.string().min(1).max(80).describe('A revision-requested work-item whose original submitter is provably gone.'),
      harness: z.string().min(1).max(120).optional().describe("Harness containing the item; 'all' and '*' are refused."),
    }),
    z.object({
      mode: z.literal('adopt-next'),
      harness: z.string().min(1).max(120).optional().describe("Harness to scan; 'all' and '*' are refused."),
    }),
  ]),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (args.mode === 'correction-base' || args.mode === 'correct') {
      const harness = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harness) return harnessRequiredResult('improvements:agent-review');
      if (!identity.workspaceId) return { content: [{ type: 'text' as const,
        text: JSON.stringify({ ok: false, mode: args.mode, reason: 'workspace-required' }) }] };
      const scope = { id: args.id, harness, workspaceId: identity.workspaceId };
      const result = args.mode === 'correction-base'
        ? await readAgentReviewCorrectionBase(scope)
        : await correctAgentReview({ ...scope, actor: identity.ownerId, requestKey: args.requestKey,
            expectedRound: args.expectedRound, correctionRevision: args.correctionRevision, correction: args.correction });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, mode: args.mode, ...result,
        ...(args.mode === 'correction-base' && 'item' in result
          ? { reviewHandoff: agentReviewEvidenceHandoff(result.item as WorkItem) } : {}) }) }] };
    }
    if (args.mode === 'claim' || args.mode === 'claim-next') {
      const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harnessSlug) return harnessRequiredResult('improvements:agent-review');
      if (args.mode === 'claim') {
        const result = await claimAgentReview({
          id: args.id,
          reviewer: identity.ownerId,
          harnessSlug,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                mode: 'claim',
                ...result,
                ...gradeHandoff(result.claimed ? result.workItem : null),
              }),
            },
          ],
        };
      }
      const record = await getClaimSpecRecord({ cupId: identity.ownerId, workspaceId: identity.workspaceId ?? undefined });
      if (record.source === 'default' && record.fleetSlug) {
        throw new Error('Review pickup requires a valid fleet claim spec; no claim was attempted.');
      }
      const workItem = await claimNextAgentReview({
        reviewer: identity.ownerId, harnessSlug, filter: record.spec.view.filter,
        workspaceId: identity.workspaceId ?? undefined, signal: ctx.signal,
        onDiagnostics: (diagnostics: AgentReviewClaimNextDiagnostics) => {
          try {
            ctx.metadata?.({ agentReviewClaimNext: diagnostics });
          } catch {
            /* Diagnostic delivery must never change claim completion or its error. */
          }
        },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'claim-next',
              claimed: workItem !== null,
              workItem,
              ...gradeHandoff(workItem),
            }),
          },
        ],
      };
    }

    if (args.mode === 'adopt' || args.mode === 'adopt-next') {
      const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harnessSlug) return harnessRequiredResult('improvements:agent-review');
      const result = args.mode === 'adopt'
        ? await adoptAgentReviewRevision({ id: args.id, adopter: identity.ownerId, harnessSlug })
        : await adoptNextAgentReviewRevision({
            adopter: identity.ownerId,
            harnessSlug,
            workspaceId: identity.workspaceId ?? undefined,
          });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, mode: args.mode, ...result,
          ...(result.workItem ? { reviewHandoff: agentReviewEvidenceHandoff(result.workItem) } : {}) }) }],
      };
    }

    const result = await resubmitAgentReview({
      id: args.id,
      submittedBy: identity.ownerId,
      ...(args.acceptance ? { acceptance: args.acceptance } : {}),
      ...(args.reproduction ? { reproduction: args.reproduction } : {}),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, mode: 'resubmit', ...result }),
        },
      ],
    };
  },
});
