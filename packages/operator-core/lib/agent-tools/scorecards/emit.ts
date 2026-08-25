/** scorecards:emit — the typed write facade over the canonical observation ledger. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getOrgPg } from '@papercusp/db-org';
import { getRubric, getRubricPlanRevision } from '../../rubrics';
import { getIssue } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { activeWorkspaceId } from '../../workspace-registry';
import { readVettingConsultCritique } from '../../consult/get-feedback-core';
import { readVettingWorkItemCritique } from '../../work-items';
import {
  normalizeScorecardRatings,
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  ObservationEvidenceError,
  type ObservationRatings,
  type ScorecardVetting,
  type ScorecardAcceptance,
  asStructuredObservation,
} from '../../harness/improvements/observation-types';
import { readRunningGeneration } from '../../scout/generation-watermark';
import {
  auditVerdictFromRatings,
  listScorecards,
  evaluateScorecardInstrumentContract,
  recordGradingAudit,
  scorecardEvidenceFingerprint,
  type ScorecardInstrumentSnapshot,
} from '../../scorecards';
import { scorecardInstrumentSnapshotSchema, scorecardRatingEntrySchema } from './evaluate';
import { acceptanceGraderLabelPrefix } from '../../acceptance-grader';
import { GRADING_INTEGRITY_RUBRIC_REF, gradingAuditGateEnabled, needsGradingAudit } from '../../grading-integrity';
import type { ScorecardGradingAudit } from '../../harness/improvements/observation-types';
import { killTask } from '../../task-manager/control';
import { listTasks } from '../../task-manager/store';
import { evaluateCriterionTestChecks, evaluateCriterionCoverageChecks } from '../../rubrics-criterion-checks';
import { resolveHarnessPaths } from '../../resolve-harness-paths';

/**
 * The `planTouched` reverse map: every implementing file the subject plan's work-items
 * recorded as changed, deduped. Returns [] when the plan exists but nothing recorded a
 * `filesChanged` — the CALLER distinguishes that from null (no plan subject at all), and
 * both refuse the check rather than widening its scope to the whole census.
 */
async function planTouchedFiles(workspaceId: string, planSlug: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows: { f: string }[] = await sql`
    SELECT DISTINCT jsonb_array_elements_text(
             COALESCE(payload->${TERMINAL_COMPLETION_EVIDENCE_KEY}->'filesChanged', '[]'::jsonb)
           ) AS f
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND source_plan_slug = ${planSlug}
  `;
  return rows.map((r) => r.f).filter((f) => typeof f === 'string' && f.trim() !== '');
}
import { readCoverage } from '../testing/coverage';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { trackDetached } from '../../detached-imports';
import { isAcceptanceAuthorIdentity } from '../../acceptance-author-identity';

/**
 * A tests-backed scorecard is intentionally a long-running write: it shells one
 * batched Vitest run before filing.  Keep the inner run comfortably inside the
 * tool's declared timeout so process-group settlement, the ledger write, and MCP
 * serialization cannot lose a race to the transport deadline.
 */
/**
 * scorecards:emit accepts deterministic checks spanning up to 50 files. A real
 * 16-file Papercusp acceptance batch takes roughly four minutes, so the old
 * two-minute inner budget rejected a fully green run before it could be filed.
 * Scale that observed batch to the schema cap (12.5 minutes), round up to 13,
 * and keep two more minutes outside the runner for process-group settlement,
 * the ledger write, and MCP serialization.
 */
export const SCORECARD_EMIT_TIMEOUT_SEC = 15 * 60;
export const SCORECARD_TEST_CHECK_TIMEOUT_MS = 13 * 60_000;

export const scorecardEmitArgs = z
  .object({
    rubricRef: z.string().min(1).max(120),
    sourceHive: z.string().min(1).max(120).optional(),
    targetHive: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(240).optional(),
    body: z.string().max(8000).optional(),
    ratings: z.record(z.string().min(1), scorecardRatingEntrySchema),
    acceptance: z
      .object({
        verdict: z.enum(['accept', 'reject']),
        reasoning: z.string().trim().min(1).max(2000),
      })
      .strict()
      .optional()
      .describe(
        "The acceptance-rubric AUTHOR's post-grading call. Valid only for kind:'acceptance', required when that author emits, and refused until a complete independent grading exists. Independent graders omit it.",
      ),
    instrumentSnapshots: z.record(z.string().min(1), scorecardInstrumentSnapshotSchema).optional(),
    subject: z
      .object({
        kind: z.enum(['agent-run', 'session', 'work-item', 'plan', 'pot', 'rubric', 'scorecard']).optional(),
        ref: z.string().min(1).max(200),
        windowStart: z.string().min(1).max(64).optional(),
        windowEnd: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional()
      .describe(
        "WHAT this scorecard grades (stored as observation.subject) — e.g. { kind:'rubric', ref:'<rubricId>' } on a vetting card.",
      ),
    vettingConsult: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Vetting linkage (consult-min-max-and-rubric-vetting-2026-08-17 P-004): conversation_id of the get_feedback consult that critiqued the vetted rubric (subject.ref names it). The rubric must exist AND the consult must carry at least one third-party critique reply (EI-20821478338037350) — an opened-but-unanswered consult is refused, not silently accepted. Stamped as observation.vetting with the critique count and critics.',
      ),
    vettingWorkItem: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Vetting linkage, work-item channel (WI-41477): the WI-/EI- work-item whose third-party COMMENTS carry the critique of the vetted rubric — the channel a LAUNCHED independent reviewer (D-049: certification goes to an agent with no history on the artifact) can actually write to, since consult participants are router-assigned and a launched reviewer is never enrolled. Same predicate as vettingConsult, mirrored clause for clause: the work-item must exist AND carry ≥1 comment authored by neither the emitter nor the vetted rubric's author. Stamped as observation.vetting { workItemId, critiquePosts, critics }. Pass EXACTLY ONE of vettingConsult / vettingWorkItem; the vettingUnanswered waiver is consult-only (a work-item with no third-party comment is not evidence — route a consult instead).",
      ),
    vettingUnanswered: z
      .boolean()
      .optional()
      .describe(
        'Attest that the cited vetting consult received NO critique (every routed reviewer was dead/parked or it expired unanswered) and you are proceeding anyway. Requires `vettingUnansweredReason`, and is REFUSED when the consult did receive critique — this is the recorded-waiver path, not a way to skip reading replies. Stamped visibly as observation.vetting.unanswered so a later reader can tell a vetted rubric from an un-critiqued one.',
      ),
    vettingUnansweredReason: z
      .string()
      .min(24)
      .max(500)
      .optional()
      .describe(
        'Why no critique was available (required with `vettingUnanswered`). Name what you actually observed — e.g. "all 3 routed reviewers ended; consult expired 19:54Z with 0 posts" — not "no reply yet".',
      ),
    supersedes: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Issue id of the earlier scorecard this corrected filing replaces.'),
    terminal: z
      .boolean()
      .optional()
      .describe(
        "Affirm the graded SUBJECT has terminated (P-008). Without it, rating any 'violatable'-class criterion stamps the card PROVISIONAL — a working note excluded from rubrics:trend until a terminal re-emit (terminal:true, supersedes the interim) makes the grading final.",
      ),
    force: z
      .boolean()
      .optional()
      .describe('File even when the canonical evidence fingerprint matches the latest scorecard.'),
  })
  .strict();

export async function cleanupAcceptanceGraderTasks(
  rubricRef: string,
  input: { workspaceId?: string } = {},
  deps: {
    list?: typeof listTasks;
    kill?: typeof killTask;
  } = {},
) {
  const prefix = acceptanceGraderLabelPrefix(rubricRef);
  const tasks = await (deps.list ?? listTasks)({
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    states: ['pending', 'running'],
    classes: ['agent-session'],
    limit: 2_000,
  });
  const matched = tasks.filter(
    (task) =>
      task.detail.headless === true && typeof task.detail.label === 'string' && task.detail.label.startsWith(prefix),
  );
  // EI-21390074563933948: these are THIS rubric's own throwaway headless graders
  // (matched by label prefix), not peer work — so a bare SIGTERM that the grader
  // tree shrugs off must ESCALATE on a bounded grace instead of returning
  // incomplete and leaving 20+ live processes behind. Same janitorial shape as
  // gc-desktop-sessions; killTask still verifies emptiness itself and never
  // reports success on a scope that would not die.
  const results = await Promise.all(
    matched.map(async (task) => ({
      taskId: task.taskId,
      outcome: await (deps.kill ?? killTask)(task.taskId, {
        includeSubtree: true,
        escalateAfterMs: 5_000,
      }),
    })),
  );
  return { prefix, matched: matched.length, results };
}

/**
 * Resolve the tree for deterministic acceptance checks. A grader may run from a
 * different Hive than the subject it is grading; in that case repo-relative test
 * paths belong to targetHive, not the grader's checkout. Same-Hive and legacy
 * callers retain the handler's caller-root behavior.
 */
async function resolveDeterministicCheckRoot(
  args: Pick<z.infer<typeof scorecardEmitArgs>, 'targetHive'>,
  input: {
    ctxHarness?: string;
    workspaceId?: string;
    checkRoot?: string;
    rubricWorkspaceId?: string | null;
  },
): Promise<string | undefined> {
  const callerRoot = input.checkRoot ?? resolveAgentWorkspaceRoot({});
  // EI-21384279769470409: a workspace-scoped superuser dispatch may omit
  // ctx.workspaceId even though the rubric itself is workspace-bound.
  const workspaceId = input.workspaceId ?? input.rubricWorkspaceId ?? undefined;
  if (!args.targetHive || args.targetHive === input.ctxHarness || !workspaceId) return callerRoot;

  const targetPaths = await resolveHarnessPaths(args.targetHive, workspaceId);
  return resolveAgentWorkspaceRoot({ projectDir: targetPaths.projectDir });
}

export async function emitScorecard(
  args: z.infer<typeof scorecardEmitArgs>,
  input: {
    createdBy: string;
    ctxHarness?: string;
    role?: string;
    workspaceId?: string;
    /** P-011 (D-006): the tree tests-check files resolve + run against — the handler
     *  passes its ctx-resolved root; omitted ⇒ the resolver's ctx-less fallback. */
    checkRoot?: string;
  },
  deps: {
    /** Injectable seam for tests — production runs the real router via the testing:run core. */
    evaluateChecks?: typeof evaluateCriterionTestChecks;
    evaluateCoverageChecks?: typeof evaluateCriterionCoverageChecks;
    /** Audited coord-identity continuity resolver. */
    sameAcceptanceAuthor?: typeof isAcceptanceAuthorIdentity;
  } = {},
) {
  const rubric = await getRubric(args.rubricRef);
  if (!rubric) return { ok: false as const, error: `rubric '${args.rubricRef}' not found` };
  try {
    const acceptance = args.acceptance as ScorecardAcceptance | undefined;
    const implementer = rubric.proposedBy ?? rubric.createdBy ?? null;
    if (acceptance && rubric.kind !== 'acceptance') {
      return {
        ok: false as const,
        error:
          "acceptance is valid only for kind:'acceptance' rubrics — a standard scorecard records ratings, not a plan ship verdict",
      };
    }
    if (rubric.kind === 'acceptance') {
      const sameAcceptanceAuthor = deps.sameAcceptanceAuthor ?? isAcceptanceAuthorIdentity;
      const identityWorkspace = rubric.workspaceId || input.workspaceId || activeWorkspaceId();
      const callerIsImplementer =
        implementer != null &&
        (await sameAcceptanceAuthor(implementer, input.createdBy, { workspaceId: identityWorkspace }));
      if (!callerIsImplementer && acceptance) {
        return {
          ok: false as const,
          error:
            `acceptance must be recorded by the acceptance-rubric author ('${implementer ?? 'unknown'}'), ` +
            `not grader '${input.createdBy}' — independent graders emit ratings without acceptance`,
        };
      }
      if (callerIsImplementer && !acceptance) {
        return {
          ok: false as const,
          error:
            "the acceptance-rubric author must record acceptance:{ verdict:'accept'|'reject', reasoning } after reading the independent grading; independent graders omit acceptance",
        };
      }
      if (callerIsImplementer && acceptance && args.supersedes) {
        return {
          ok: false as const,
          error:
            "the acceptance-rubric author's verdict is a separate newer scorecard and must not use supersedes; omit supersedes so the independent grading remains visible to the plan-acceptance gate",
        };
      }
      if (callerIsImplementer) {
        const prior = await listScorecards({ rubricRef: args.rubricRef, limit: 50 });
        let independent = undefined;
        for (const card of prior) {
          if (!card.rubricResolved || card.missingKeys.length !== 0 || card.synthesized || card.createdBy == null)
            continue;
          if (!(await sameAcceptanceAuthor(implementer, card.createdBy, { workspaceId: identityWorkspace }))) {
            independent = card;
            break;
          }
        }
        if (!independent) {
          return {
            ok: false as const,
            error:
              `acceptance must follow a complete independent grading by someone other than '${implementer}' — ` +
              `have a non-implementer emit ratings first, then record the implementer's verdict`,
          };
        }
      }
    }
    const ratings = normalizeScorecardRatings(args.ratings as ObservationRatings, rubric);
    const observationForValidation = { rubricRef: args.rubricRef, ratings };
    validateObservationRatings(observationForValidation);
    validateScorecardCompleteness(
      observationForValidation,
      rubric.criteria.map((criterion) => criterion.key),
    );
    validateScorecardRatingValues(observationForValidation, rubric);
    const instrumentSnapshots = args.instrumentSnapshots as Record<string, ScorecardInstrumentSnapshot> | undefined;
    const evidenceFingerprint = scorecardEvidenceFingerprint({
      rubricRef: args.rubricRef,
      ratings,
      instrumentSnapshots,
      ...(acceptance ? { acceptance } : {}),
    });
    const instrumentContract = evaluateScorecardInstrumentContract({
      rubric,
      ratings,
      instrumentSnapshots,
    });
    if (rubric.releaseGating && !instrumentContract.valid) {
      return {
        ok: false as const,
        error:
          `release-gating instrument contract invalid for '${args.rubricRef}' — ` +
          'inspect instrumentContract for missing/stale/window/verdict mismatches',
        instrumentContract,
      };
    }
    // ── the vetting stamp (consult-min-max-and-rubric-vetting-2026-08-17 P-004) ──
    // A vetting scorecard (meta-rubric grading of an acceptance rubric) links the
    // get_feedback consult that critiqued the rubric and pins the rubric's plan-row
    // version, so the acceptance gate can tell whether the attestation still covers
    // the CURRENT revision. Both halves are validated to EXIST before anything is
    // stamped — the gate trusts the stamp rather than re-querying, so a dangling
    // link here would be a booby trap (same posture as the acceptance-kind link
    // guards in proposeRubric).
    let vetting: ScorecardVetting | undefined;
    // WI-41477: two alternate recording channels, one predicate. The consult channel
    // is the router-assigned get_feedback flow; the work-item channel is where a
    // LAUNCHED independent reviewer's critique actually lands (D-049 — consult
    // participants are router-assigned, so a reviewer launched to certify a specific
    // artifact can never post into a consult thread). Exactly one may be passed.
    if (args.vettingConsult && args.vettingWorkItem) {
      return {
        ok: false as const,
        error:
          'pass EXACTLY ONE of vettingConsult / vettingWorkItem — they are alternate recording channels for the ' +
          'same attestation, and a card stamped from both would be unreadable as evidence',
      };
    }
    if (args.vettingWorkItem && args.vettingUnanswered) {
      return {
        ok: false as const,
        error:
          'vettingUnanswered is consult-only — it waives a consult nobody answered. A work-item with no ' +
          'third-party comment is not attestable evidence; route a consult (vettingConsult) and waive THAT if no ' +
          'reviewer can be had',
      };
    }
    if (args.vettingConsult || args.vettingWorkItem) {
      const subjectRef = args.subject?.ref;
      if (!subjectRef) {
        return {
          ok: false as const,
          error:
            "vetting linkage requires `subject` naming the vetted rubric — pass subject:{ kind:'rubric', ref:'<the acceptance rubricId>' }",
        };
      }
      const vettedRubric = await getRubric(subjectRef);
      if (!vettedRubric) {
        return {
          ok: false as const,
          error: `vetting subject '${subjectRef}' does not resolve to a rubric — the vetting stamp would be a dangling link`,
        };
      }
      if (args.vettingWorkItem) {
        // Mirror of the consult predicate below, clause for clause: the consult path
        // excludes the emitter and the consult REQUESTER; here the analogous
        // self-review parties are the emitter and the vetted rubric's author (the
        // vetting requester in the launched-reviewer flow).
        const critique = await readVettingWorkItemCritique(args.vettingWorkItem, [
          input.createdBy,
          vettedRubric.createdBy,
          vettedRubric.proposedBy,
        ]);
        if (!critique.exists) {
          return {
            ok: false as const,
            error:
              `vetting work-item '${args.vettingWorkItem}' not found — the vetting stamp would be a dangling link. ` +
              `Pass the WI-/EI- id of the review work-item whose comments carry the critique of rubric '${subjectRef}'`,
          };
        }
        if (critique.critiquePosts === 0) {
          return {
            ok: false as const,
            error:
              `vetting work-item '${args.vettingWorkItem}' carries NO third-party critique: comments by the emitter ` +
              `or the vetted rubric's author do not count — independent review means someone ELSE engaged with ` +
              `rubric '${subjectRef}'. A vetting attestation over an un-critiqued work-item would make the ` +
              `acceptance gate vacuously green. If no reviewer can be had at all, use the consult channel ` +
              `(vettingConsult + vettingUnanswered) so the waiver is recorded visibly`,
          };
        }
        const rubricRevision = await getRubricPlanRevision(subjectRef);
        vetting = {
          workItemId: args.vettingWorkItem,
          ...(rubricRevision != null ? { rubricRevision } : {}),
          critiquePosts: critique.critiquePosts,
          ...(critique.critics.length > 0 ? { critics: critique.critics } : {}),
        };
      }
    }
    if (args.vettingConsult) {
      const subjectRef = args.subject!.ref;
      const critique = await readVettingConsultCritique(
        getOrgPg().sql,
        activeWorkspaceId(),
        args.vettingConsult,
        input.createdBy,
      );
      if (!critique.exists) {
        return {
          ok: false as const,
          error:
            `vetting consult '${args.vettingConsult}' not found in consult_state — open the critique consult first ` +
            `(consult:get_feedback about rubric '${subjectRef}') and pass its conversation_id`,
        };
      }
      // EI-20821478338037350: the gate's purpose is EXTERNAL CRITIQUE, so the
      // predicate has to be "someone critiqued it", not "a consult row exists".
      // The two failure modes are reported apart because their remedies differ:
      // silence means wait or re-route; a decline means the reviewer already
      // told you they cannot help, so waiting is pointless.
      const waived = args.vettingUnanswered === true;
      if (critique.critiquePosts === 0 && !waived) {
        const because =
          critique.declinePosts > 0
            ? `every routed reviewer DECLINED (${critique.declinePosts} decline post(s)) — waiting will not produce critique, so re-route the consult`
            : `nobody has replied yet (consult state '${critique.state ?? 'unknown'}') — wait for critique or re-route the consult`;
        return {
          ok: false as const,
          error:
            `vetting consult '${args.vettingConsult}' exists but carries NO critique: ${because}. ` +
            `A vetting attestation over an un-critiqued consult would make the acceptance gate vacuously green. ` +
            `If no reviewer can be had at all, say so explicitly: vettingUnanswered:true + vettingUnansweredReason:'<what you observed>'.`,
        };
      }
      if (waived && critique.critiquePosts > 0) {
        return {
          ok: false as const,
          error:
            `vettingUnanswered was passed, but consult '${args.vettingConsult}' DID receive critique ` +
            `(${critique.critiquePosts} post(s) from ${critique.critics.join(', ')}) — read the critique, improve the ` +
            `rubric from it, and re-emit without the waiver`,
        };
      }
      if (waived && !args.vettingUnansweredReason) {
        return {
          ok: false as const,
          error:
            'vettingUnanswered requires vettingUnansweredReason — an unexplained no-critique waiver is exactly the ' +
            'silent pass this gate exists to prevent',
        };
      }
      const rubricRevision = await getRubricPlanRevision(subjectRef);
      vetting = {
        consultId: args.vettingConsult,
        ...(rubricRevision != null ? { rubricRevision } : {}),
        critiquePosts: critique.critiquePosts,
        ...(critique.critics.length > 0 ? { critics: critique.critics } : {}),
        ...(waived ? { unanswered: true as const, unansweredReason: args.vettingUnansweredReason } : {}),
      };
    }
    // P-008 (EI-20581177540737568): a 'violatable' criterion is monotonic-downward — one
    // violation falsifies it permanently — so a mid-run rating of one cannot be final.
    // DEFAULT IS PROVISIONAL: the emitter must AFFIRM subject termination (terminal:true)
    // to file a final card. Forgetting the flag yields a card that doesn't count toward
    // the trend, never a false final (WI-39348's exemplary went stale 28 minutes after
    // an honest interim grade; the burden now sits on the safe side by construction).
    const violatableRatedKeys = rubric.criteria
      .filter((c) => c.criterionClass === 'violatable' && ratings[c.key] !== undefined)
      .map((c) => c.key);
    const provisional =
      !args.terminal && violatableRatedKeys.length > 0
        ? { violatableKeys: violatableRatedKeys, stampedAt: new Date().toISOString() }
        : undefined;
    // ── P-013 (D-004): grade-the-grader ──
    // AUDIT PATH — this emit IS a grading audit (rubricRef = the meta-rubric).
    // Validated BEFORE filing: an audit card filed and then unable to settle its
    // subject would strand both halves. Mirrors the acceptance grader ≠ author rule.
    let auditContext: { subjectIssueId: string; auditor: string } | null = null;
    if (args.rubricRef === GRADING_INTEGRITY_RUBRIC_REF) {
      if (args.subject?.kind !== 'scorecard' || !args.subject.ref) {
        return {
          ok: false as const,
          error:
            "grading-integrity audits a SCORECARD — pass subject:{ kind:'scorecard', ref:'<the graded card's issue id>' } (D-004: terminal cards only, one level deep)",
        };
      }
      const graded = await getIssue(args.subject.ref);
      const gradedObservation =
        graded?.payload && typeof graded.payload === 'object' && !Array.isArray(graded.payload)
          ? asStructuredObservation((graded.payload as { observation?: unknown }).observation)
          : undefined;
      if (!gradedObservation?.rubricRef || !gradedObservation.ratings) {
        return { ok: false as const, error: `audit subject '${args.subject.ref}' is not a scorecard` };
      }
      if (!gradedObservation.gradingAudit) {
        return {
          ok: false as const,
          error: `audit subject '${args.subject.ref}' carries no gradingAudit stamp — only terminal standard-rubric cards emitted under the audit gate are auditable`,
        };
      }
      if (gradedObservation.gradingAudit.state !== 'pending') {
        return {
          ok: false as const,
          error: `audit subject '${args.subject.ref}' is already audited (${gradedObservation.gradingAudit.state}) — supersede the AUDIT card instead of re-auditing (D-004: one level, no regress)`,
        };
      }
      const gradedAuthor = graded?.createdBy ?? null;
      // Unattributable identity on EITHER side refuses — strict toward auditing again.
      if (!gradedAuthor || !input.createdBy || gradedAuthor === input.createdBy) {
        return {
          ok: false as const,
          error: `self_audit_refused: a grading audit must come from a NON-AUTHOR (graded card author: ${gradedAuthor ?? 'unknown'}, auditor: ${input.createdBy ?? 'unknown'}) — mirror of the acceptance grader ≠ author rule`,
        };
      }
      auditContext = { subjectIssueId: args.subject.ref, auditor: input.createdBy };
    }
    // PENDING STAMP — a terminal standard-rubric card is final but UNAUDITED until a
    // non-author audit settles it (never the audit card itself: one level).
    let gradingAudit: ScorecardGradingAudit | undefined;
    if (
      needsGradingAudit({
        rubricKind: rubric.kind,
        rubricRef: args.rubricRef,
        provisional: provisional !== undefined,
      }) &&
      (await gradingAuditGateEnabled())
    ) {
      gradingAudit = {
        state: 'pending',
        metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
        stampedAt: new Date().toISOString(),
      };
    }
    const sourceHive = args.sourceHive ?? input.ctxHarness;
    if (args.supersedes) {
      const superseded = await getIssue(args.supersedes);
      const raw =
        superseded?.payload && typeof superseded.payload === 'object' && !Array.isArray(superseded.payload)
          ? (superseded.payload as { observation?: unknown }).observation
          : undefined;
      const prior = asStructuredObservation(raw);
      if (!prior?.rubricRef || !prior.ratings) {
        return { ok: false as const, error: `superseded scorecard '${args.supersedes}' not found` };
      }
      if (prior.rubricRef !== args.rubricRef) {
        return {
          ok: false as const,
          error: `superseded scorecard '${args.supersedes}' grades '${prior.rubricRef}', not '${args.rubricRef}'`,
        };
      }
      if ((prior.sourceHive ?? undefined) !== (sourceHive ?? undefined)) {
        return {
          ok: false as const,
          error: `superseded scorecard '${args.supersedes}' belongs to sourceHive '${prior.sourceHive ?? ''}', not '${sourceHive ?? ''}'`,
        };
      }
    }
    const latest = (await listScorecards({ rubricRef: args.rubricRef, sourceHive, limit: 1 }))[0];
    const latestFingerprint = latest
      ? (latest.evidenceFingerprint ??
        scorecardEvidenceFingerprint({
          rubricRef: latest.rubricRef,
          ratings: latest.ratings,
          ...(latest.acceptance ? { acceptance: latest.acceptance } : {}),
        }))
      : null;
    const sameCorrectionAlreadyExists = args.supersedes && latest?.supersedes === args.supersedes;
    // P-008: a terminal re-emit of IDENTICAL ratings is the finalization step, not a
    // duplicate — the fingerprint (rubricRef+ratings+snapshots, unchanged for
    // compatibility with stored rows) cannot see finality, so compare it separately.
    const finalityChanged = latest !== undefined && (latest.provisional !== undefined) !== (provisional !== undefined);
    // P-004: a re-emit that only moves the vetting stamp — a new consult, or the same
    // consult re-attested against a NEW rubric revision after the author improved the
    // rubric — is the re-vetting step, not a duplicate. The fingerprint cannot see it
    // (rubricRef + ratings + snapshots only, unchanged for stored-row compatibility),
    // so compare the stamps separately, like finality above.
    // EI-20821478338037350: the waiver→critiqued upgrade is the same kind of move.
    // An author who honestly attested `unanswered` and LATER receives critique must be
    // able to re-emit the real stamp over the waived one; without this the fingerprint
    // (identical rubricRef + ratings + consult + revision) declines it as unchanged and
    // the recorded waiver is stuck on the card forever.
    const vettingChanged =
      (latest?.vetting?.consultId ?? null) !== (vetting?.consultId ?? null) ||
      // WI-41477: the work-item channel is the same kind of move — a re-emit that
      // switches channel or cites a different review work-item is a re-vetting step.
      (latest?.vetting?.workItemId ?? null) !== (vetting?.workItemId ?? null) ||
      (latest?.vetting?.rubricRevision ?? null) !== (vetting?.rubricRevision ?? null) ||
      (latest?.vetting?.unanswered ?? false) !== (vetting?.unanswered ?? false);
    if (
      !args.force &&
      !finalityChanged &&
      !vettingChanged &&
      latestFingerprint === evidenceFingerprint &&
      (!args.supersedes || sameCorrectionAlreadyExists)
    ) {
      const acceptanceGraderCleanup =
        rubric.kind === 'acceptance' && input.role === 'judge'
          ? await cleanupAcceptanceGraderTasks(args.rubricRef, { workspaceId: input.workspaceId })
          : undefined;
      return {
        ok: true as const,
        created: false,
        reason: 'unchanged-evidence' as const,
        evidenceFingerprint,
        previousIssueId: latest?.issueId ?? null,
        canonicalRatings: ratings,
        ...(acceptanceGraderCleanup ? { acceptanceGraderCleanup } : {}),
      };
    }

    // ── P-011 (owner-ratified D-006): deterministic criterion checks ──
    // Every RATED criterion whose rubric check is kind:'tests' has its files actually
    // RUN here, at grading time (never a stale ledger read): a path that no longer
    // resolves refuses the emit, an unjudgeable run refuses the emit, and a
    // pass-claiming rating the run contradicts refuses the emit. Placed AFTER the
    // unchanged-evidence decline above so a deduped re-emit never burns a test run,
    // and BEFORE the write so a card is only ever filed with its live check verdicts
    // stamped (observation.checkRuns). Criteria without a tests-check are untouched.
    let checkRuns: Record<string, import('../../rubrics-criterion-checks').CriterionCheckRun> | undefined;
    const testCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'tests');
    if (testCheckedCriteria.length > 0) {
      const evaluateChecks = deps.evaluateChecks ?? evaluateCriterionTestChecks;
      const checkRoot = await resolveDeterministicCheckRoot(args, {
        ...input,
        rubricWorkspaceId: rubric.workspaceId,
      });
      const checkEvaluation = await evaluateChecks({
        criteria: rubric.criteria,
        ratings,
        ...(checkRoot ? { root: checkRoot } : {}),
        // One shared budget for the batched run. scorecards:emit declares a longer
        // tool timeout below, so the transport gives this mutation enough time to
        // return a typed verdict (and still leaves a full minute for process-group
        // settlement, the ledger write, and response serialization).
        timeoutMs: SCORECARD_TEST_CHECK_TIMEOUT_MS,
      });
      if (!checkEvaluation.ok) {
        return {
          ok: false as const,
          error: checkEvaluation.detail,
          checkRefusal: checkEvaluation,
        };
      }
      checkRuns = Object.keys(checkEvaluation.checkRuns).length > 0 ? checkEvaluation.checkRuns : undefined;
    }

    // ── P-006 (deterministic-coverage-census): kind:'coverage' criterion checks ──
    // The census counterpart of the block above, and it reads THE shared derivation
    // (`readCoverage`) rather than querying testing_surface_depth itself — the panel,
    // both state cells, the tool and now this gate all resolve through one function, so
    // the gate cannot disagree with the panel a human just read. A scope matching zero
    // surfaces REFUSES (a coverage gate over an empty scope is vacuously green, which is
    // precisely the defect this plan exists to make unrepresentable).
    const coverageCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'coverage');
    if (coverageCheckedCriteria.length > 0) {
      const evaluateCoverage = deps.evaluateCoverageChecks ?? evaluateCriterionCoverageChecks;
      // Hoisted to local consts so the narrowing survives into the closure below —
      // narrowing a property access does not carry across a function boundary.
      const subjectPlan = rubric.subjectPlan;
      const workspaceId = input.workspaceId;
      const coverageEvaluation = await evaluateCoverage({
        criteria: rubric.criteria,
        ratings,
        readCoverage: (a) => readCoverage(a),
        // planTouched resolves to the files the subject plan's COMPLETED work actually
        // changed. Only an acceptance rubric has a subject plan; anywhere else this
        // returns null and the check refuses rather than silently widening its scope.
        // The workspace is required for the SAME reason: planTouchedFiles filters on
        // `workspace_id`, so resolving it without one would widen the scope to every
        // workspace's rows — the silent-widening this check exists to refuse.
        resolvePlanTouchedFiles: () =>
          subjectPlan && workspaceId ? planTouchedFiles(workspaceId, subjectPlan) : Promise.resolve(null),
      });
      if (!coverageEvaluation.ok) {
        return {
          ok: false as const,
          error: coverageEvaluation.detail,
          checkRefusal: coverageEvaluation,
        };
      }
      if (Object.keys(coverageEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...coverageEvaluation.checkRuns };
      }
    }

    const gradedGeneration = await readRunningGeneration().catch(() => null);
    const result = await captureImprovement({
      title: args.title ?? `Scorecard: ${rubric.title}${sourceHive ? ` — ${sourceHive}` : ''}`,
      kind: 'change',
      body: args.body,
      lane: 'observation',
      // D-002 (observation-lane-scorecard-classification-2026-08-16): an emitted
      // scorecard is a COMPLETED verdict — file it terminal so it never renders as
      // an untriaged open observation. Reads are state-agnostic (scorecards:list
      // selects on payload.observation.rubricRef only), so history/trends/gates
      // are unaffected.
      initialState: 'done',
      createdBy: input.createdBy,
      filedByRole: 'su',
      payloadExtra: {
        observation: {
          rubricRef: args.rubricRef,
          ratings,
          ...(acceptance ? { acceptance } : {}),
          ...(sourceHive ? { sourceHive } : {}),
          ...(args.targetHive ? { targetHive: args.targetHive } : {}),
          ...(instrumentSnapshots ? { instrumentSnapshots } : {}),
          evidenceFingerprint,
          ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          ...(gradedGeneration ? { gradedGeneration } : {}),
          ...(provisional ? { provisional } : {}),
          ...(gradingAudit ? { gradingAudit } : {}),
          ...(args.subject ? { subject: args.subject } : {}),
          ...(vetting ? { vetting } : {}),
          ...(checkRuns ? { checkRuns } : {}),
        },
      },
    });
    if (result.created) {
      // Push-on-write (push-audit 2026-07-26): the Verify stage's scorecard
      // list + rubric trend + release-readiness strip all fold this filing in.
      void trackDetached(import('../../sync-sse'))
        .then((m) => {
          m.notifySyncInvalidate('scorecards.list');
          m.notifySyncInvalidate('rubrics.trend');
          m.notifySyncInvalidate('learning.releaseReadiness');
        })
        .catch(() => {});
    }
    // P-013: settle the audited card's stamp now that the audit card is filed. A
    // settlement failure is surfaced loudly, never swallowed — the auditor must know
    // the subject is still pending.
    let auditSettlement: Awaited<ReturnType<typeof recordGradingAudit>> | undefined;
    if (auditContext && result.created && result.issue?.id) {
      auditSettlement = await recordGradingAudit(auditContext.subjectIssueId, {
        auditIssueId: result.issue.id,
        auditor: auditContext.auditor,
        verdict: auditVerdictFromRatings(ratings),
      });
    }
    const acceptanceGraderCleanup =
      rubric.kind === 'acceptance' && input.role === 'judge'
        ? await cleanupAcceptanceGraderTasks(args.rubricRef, { workspaceId: input.workspaceId })
        : undefined;
    return {
      ok: true as const,
      created: result.created,
      issueId: result.issue?.id ?? null,
      evidenceFingerprint,
      // P-013: surfaced loudly — this card does not enter the trend until audited.
      ...(gradingAudit ? { gradingAuditPending: true } : {}),
      ...(auditSettlement
        ? {
            gradingAuditRecorded: auditSettlement.ok,
            ...(auditSettlement.gradingAudit ? { gradingAudit: auditSettlement.gradingAudit } : {}),
            ...(auditSettlement.error ? { gradingAuditError: auditSettlement.error } : {}),
          }
        : {}),
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      canonicalRatings: ratings,
      ...(acceptance ? { acceptance } : {}),
      // P-008: surfaced loudly so the emitter knows this card is a working note — a
      // terminal re-emit (terminal:true, supersedes this issueId) finalizes it.
      ...(provisional ? { provisional } : {}),
      // P-011: the live deterministic check verdicts this card was filed with.
      ...(checkRuns ? { checkRuns } : {}),
      ...(acceptanceGraderCleanup ? { acceptanceGraderCleanup } : {}),
    };
  } catch (error) {
    if (error instanceof ObservationEvidenceError) return { ok: false as const, error: error.message };
    throw error;
  }
}

export default defineTool({
  name: 'scorecards:emit',
  profile: 'engineer',
  description:
    "Validate, canonicalize, and file one COMPLETE rubric scorecard through the existing observation ledger. Requires evidence for every declared criterion. For kind:'acceptance', a non-implementer emits ratings first; the rubric author then emits a separate newer card with acceptance:{verdict,reasoning} and no supersedes, so the independent grading remains visible to the plan-acceptance gate. Stamps the running generation, stores deterministic instrument snapshots, and declines unchanged evidence by fingerprint unless force:true.",
  guidance: {
    when: 'Filing a GRADE-mode or release-readiness scorecard. Prefer this typed surface over hand-assembling improvements:capture observation payloads.',
    notWhen:
      'Building the grading skeleton or previewing a delta — scorecards:evaluate. Free-text observations — improvements:capture.',
    chaining:
      'scorecards:evaluate { rubricRef } → grade every returned criterion → scorecards:emit { rubricRef, ratings, instrumentSnapshots } → scorecards:list / rubrics:trend. For acceptance rubrics, the non-implementer grading and the author acceptance are separate cards; do not pass supersedes on the author acceptance.',
    seeAlso: ['scorecards:evaluate', 'scorecards:list', 'rubrics:trend'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // P-011 (D-006): grading a rubric with tests-checks shells a real Vitest run and can
  // block for tens of seconds without ever reading `ctx.tx` — holding the ambient
  // workspace transaction across that wait would trip idle_in_transaction_session_timeout
  // (60s), surfacing as a bare `write CONNECTION_CLOSED`. Same declaration as
  // testing:run, for the same reason; every DB access here manages its own connection.
  skipWorkspaceTx: true,
  // EI-20965113106044588: the deterministic gate can legitimately exceed the flat
  // 55s MCP deadline. Declaring the real tool budget makes effectiveMcpDeadlineMs
  // extend the transport race instead of returning request_timeout while the
  // mutation is still running server-side.
  timeoutSec: SCORECARD_EMIT_TIMEOUT_SEC,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: scorecardEmitArgs,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ctxHarness =
      typeof ctx.harnessSlug === 'string' && ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : undefined;
    return {
      data: await emitScorecard(args, {
        createdBy: identity.ownerId,
        ctxHarness,
        role: ctx.role,
        workspaceId: identity.workspaceId ?? undefined,
        // P-011: tests-checks resolve + run against the tree the AGENT edits.
        checkRoot: resolveAgentWorkspaceRoot(ctx),
      }),
    };
  },
});
