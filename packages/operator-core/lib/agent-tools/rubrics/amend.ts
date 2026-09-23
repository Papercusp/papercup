/**
 * rubrics:amend — patch ONE criterion field and/or the rubric-level methodRef
 * without the whole-document rubrics:propose replace (rubric-system-improvements-
 * 2026-07-12 P-003). The replace ceremony (refetch → resubmit every criterion →
 * ack loss-guards) deterred a same-day one-paragraph amendment; small rubric
 * improvements were being skipped. Amending preserves the stored lifecycle
 * status — an active rubric stays active.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  amendRubric,
  previewAcceptanceBarAmendment,
  rubricCompleteness,
  AMENDABLE_CRITERION_FIELDS,
  type AmendRubricInput,
} from '../../rubrics';
import { validateRubricReplicationSql } from '../../rubrics-replication-sql';
import { trackDetached } from '../../detached-imports';
import { requirementCriterionInputSchema, requirementAmendmentSchema } from '../plans/rubric-template';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { lintAcceptanceCriterionMethods } from '../../rubrics-method-lint';
import { runtimeVettingFindings } from '../../acceptance-runtime-citation';

const amendmentCriterionSchema = requirementCriterionInputSchema;

export const rubricsAmendArgs = z
  .object({
    rubricRef: z.string().min(1).max(120).describe('the rubric ref/slug to amend'),
    requirement: requirementAmendmentSchema
      .optional()
      .describe(
        'patch one requirement Intent, Acceptance or Verification; promise changes use the BAR amendment transaction',
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Preview a BAR meaning amendment without writing; returns exact approval JSON. Post preview.approval VERBATIM as a work_items:comment on a thread you can write to, then send the outside-lineage reviewer a pointer to that post (coord:send caps a body at 600 characters). The reviewer re-posts the exact JSON as a work_items:comment on any existing thread they can write to, preferably a work-item they already hold, and returns that post id. The resolver looks up local post ids within the workspace, not by the requester's thread; do not create a counter-sign work-item just for this approval.",
      ),
    criteria: z
      .array(amendmentCriterionSchema)
      .min(1)
      .max(200)
      .optional()
      .describe(
        'acceptance-kind only: replace the COMPLETE criterion set through the atomic BAR amendment transaction. Use this when adding a BAR or binding structured checks across the set; read rubrics:get first and resubmit every stored criterion. Alias contract: prefer structured intent/acceptance/verification sections and omit legacy top-level aliases; when both forms are supplied, corresponding values (`bar`/`model`↔`acceptance.condition`, `driftMarkers`↔`acceptance.falsifier`, and verification fields) must match after canonical normalization or validation fails with `requirement_alias_conflict`',
      ),
    criterionEvidencePlane: z
      .object({ key: z.string().min(1), evidencePlane: z.enum(['tree', 'deployed', 'live']) })
      .optional()
      .describe(
        'change one acceptance criterion structural evidence plane through the canonical BAR amendment transaction',
      ),
    criterion: z
      .object({
        key: z.string().min(1).describe('the criterion key (must exist — keys are identity, not amendable)'),
        field: z.enum(AMENDABLE_CRITERION_FIELDS).describe('which prose field to patch'),
        mode: z
          .enum(['append', 'replace'])
          .describe(
            "'append' adds text as a new paragraph (never guarded); 'replace' swaps the whole field (shrink-guarded)",
          ),
        text: z.string().min(1).max(20000).describe('the text to append / the full replacement text'),
      })
      .optional()
      .describe('patch one criterion field'),
    criterionClass: z
      .object({
        key: z.string().min(1).describe('the criterion key (must exist)'),
        class: z.enum(['settle-once', 'violatable']),
      })
      .optional()
      .describe(
        "set one criterion's grading class (P-008). UPGRADE-ONLY here: tagging 'violatable' tightens grading, so it keeps status + ratifier; downgrading a stored 'violatable' is refused — use rubrics:propose with classDowngradeReason",
      ),
    methodRef: z
      .string()
      .max(200)
      .optional()
      .describe('set/replace the agent-insights runbook slug for the rubric-level method'),
    classRef: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'acceptance-kind only: bind a missing class to an existing standard rubric while preserving every BAR and criterion; an existing class may be repeated but not replaced',
      ),
    composes: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(16)
      .optional()
      .describe(
        'replace the unpinned composition refs with existing standard-kind rubric ids; omit to preserve the current list (revision pins are intentionally not supported)',
      ),
    allowMethodShrink: z
      .boolean()
      .optional()
      .describe(
        "loss-guard ack for mode:'replace' that shrinks a procedure >40% or drops its REPLICATION DRILL marker; requires shrinkReason",
      ),
    shrinkReason: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('why the shrink is intentional (required with allowMethodShrink)'),
    reason: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe('reason for a started-BAR meaning amendment; recorded on the subject-plan Decision'),
    expectedRubricRevision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('optimistic CAS for the acceptance-rubric plan revision'),
    expectedSubjectPlanRevision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('optimistic CAS for the subject-plan revision'),
    idempotencyKey: z.string().min(1).max(200).optional().describe('stable replay token for a started-BAR amendment'),
    approvalRef: z
      .string()
      .min(1)
      .max(240)
      .optional()
      .describe(
        'thread-post:<id> containing the preview approval JSON, authored by an authenticated outside-lineage reviewer. This authorizes a patch but is not itself a patch; include at least one amendment field.',
      ),
    approvedBy: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'optional assertion of the reviewer identity; must match the approval post author. ALSO PASS IT ON dryRun:true TO SCREEN A CANDIDATE FIRST, not after they spent a review wake on an approval void from the start (EI-23806582233421348): returns approverEligibility { eligible, relatedImplementer, relatedVia, eligibleWithUnrelatedApplier }. eligible predicts YOUR OWN apply and implementers[] includes YOU, so screening YOURSELF is always false and proves nothing (WI-10002357); relatedVia:"caller" is a curable artifact — have a different agent apply.',
      ),
    approvedAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('legacy hint; authoritative approval time is always read from the post'),
    faultInjection: z
      .enum(['after-decision', 'after-rubric', 'after-projection', 'after-rebind'])
      .optional()
      .describe('test-only rollback probe'),
  })
  .superRefine((args, ctx) => {
    if (args.requirement && (args.criteria || args.criterion || args.criterionClass || args.criterionEvidencePlane)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requirement'],
        message: 'requirement amendment cannot be combined with other criterion patches',
      });
    }
    if (args.criteria && (args.criterion || args.criterionClass || args.criterionEvidencePlane)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message:
          'criteria is the complete replacement set and cannot be combined with criterion, criterionClass, or criterionEvidencePlane patches',
      });
    }
    const hasPatch =
      args.requirement !== undefined ||
      args.criteria !== undefined ||
      args.criterionEvidencePlane !== undefined ||
      args.criterion !== undefined ||
      args.criterionClass !== undefined ||
      args.methodRef !== undefined ||
      args.classRef !== undefined ||
      args.composes !== undefined;
    if (!hasPatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          'nothing to amend — include at least one amendment field; approvalRef authorizes a patch but does not supply one',
      });
    }
  });

export default defineTool({
  name: 'rubrics:amend',
  profile: 'engineer',
  description:
    "Patch one rubric criterion/requirement, complete acceptance criteria, evidence plane, or rubric refs. An approvalRef authorizes a patch but never substitutes for one; include at least one amendment field. Use rubrics:propose for standard rubric revisions. Acceptance methods that prescribe native shell commands return a non-blocking methodLint advisory because judges cannot run shell; MCP tools such as testing:run remain valid. For a started BAR meaning change, use dryRun:true and post its returned approval JSON on a thread you can write to; send the outside-lineage reviewer a pointer. Have the reviewer re-post it verbatim on any thread they can write to, preferably an item they already hold, then apply approvalRef:'thread-post:<id>'. The lookup is workspace-wide by local post id, not tied to the requester's thread; do not create a counter-sign work-item just for the approval. Subject Decision, BAR/spec revisions, and rebind commit atomically; old proof/grades remain history and the existing shrink guard applies.",
  guidance: {
    when: 'A targeted acceptance-BAR change, evidence-plane binding, or rubric-ref update.',
    notWhen:
      'For standard rubric criteria, key, or rating changes use rubrics:propose. Complete `criteria` is acceptance-only and must preserve stored keys unless removal is explicitly allowed.',
    chaining:
      "rubrics:get → rubrics:amend. Started BAR: amend { dryRun:true } → requester posts preview.approval VERBATIM as a work_items:comment on a thread they can write to and sends the reviewer a pointer (cap: 600 characters). The reviewer re-posts that exact JSON as a work_items:comment on any existing thread they can write to, preferably an item they already hold, then returns the post id. `thread-post:<id>` resolves a local post by workspace and id; it is not bound to the requester's thread. Do not create a counter-sign work-item just for the approval. Apply with amend { approvalRef:'thread-post:<reviewer post id>' }. Never truncate or retype approval JSON.",
    seeAlso: [
      'rubrics:propose (whole-document revision)',
      'rubrics:get (read before amending)',
      'work_items:comment (post the exact approval JSON as a Threadable body)',
      'coord:send (send only the short reviewer pointer)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: rubricsAmendArgs,
  async handler(args, ctx) {
    // ⚠ DO NOT pass `by: id.ownerId` here. AMENDING IS NOT AUTHORING (EI-10746 follow-on,
    // 2026-07-12). A rubric persists as a PLAN, and a plan has ONE `owner` — so
    // planRowToRubric projects createdBy AND proposedBy AND ratifiedBy from that single
    // field (rubrics.ts:213-215). Forcing `by` to the caller therefore silently TRANSFERS
    // AUTHORSHIP of the rubric to whoever amends it.
    //
    // That is not cosmetic: D-012 requires a NON-AUTHOR to ratify. So a reviewer who
    // improves a rubric before ratifying it — exactly the diligent path — becomes its
    // recorded author, and their ratification is silently converted into the
    // SELF-RATIFICATION the rule exists to forbid. The act of reviewing well disqualified
    // the reviewer. Observed live: a non-author ratifier amended blender-release-readiness
    // and instantly became its createdBy/proposedBy, erasing su-eb9b7ae3.
    //
    // amendRubric already does the right thing on its own (`input.by ?? stored.createdBy`,
    // rubrics.ts:801) — that fallback preserves the original author. It was simply DEAD,
    // because this wrapper always supplied `by`. Omitting it lets the guard actually run.
    //
    // Who amended is not lost: per D-002 the plan's revision spine carries the edit history.
    // (The deeper defect — that proposedBy/ratifiedBy are unrepresentable because all three
    // identities collapse onto plan.owner, making D-012 unauditable — is tracked separately.)
    const identity = resolveAgentIdentity(ctx); // authz/identity side-effects + a clear failure if unidentified
    const input: AmendRubricInput = {
      rubricId: args.rubricRef,
      ...(args.requirement ? { requirement: args.requirement } : {}),
      ...(args.criteria ? { criteria: args.criteria } : {}),
      ...(args.criterion ? { criterion: args.criterion } : {}),
      ...(args.criterionClass ? { criterionClass: args.criterionClass } : {}),
      ...(args.criterionEvidencePlane ? { criterionEvidencePlane: args.criterionEvidencePlane } : {}),
      ...(args.methodRef !== undefined ? { methodRef: args.methodRef } : {}),
      ...(args.classRef !== undefined ? { classRef: args.classRef } : {}),
      ...(args.composes !== undefined ? { composes: args.composes } : {}),
      ...(args.allowMethodShrink !== undefined ? { allowMethodShrink: args.allowMethodShrink } : {}),
      ...(args.shrinkReason !== undefined ? { shrinkReason: args.shrinkReason } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.expectedRubricRevision !== undefined ? { expectedRubricRevision: args.expectedRubricRevision } : {}),
      ...(args.expectedSubjectPlanRevision !== undefined
        ? { expectedSubjectPlanRevision: args.expectedSubjectPlanRevision }
        : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.approvalRef !== undefined ? { approvalRef: args.approvalRef } : {}),
      ...(args.approvedBy !== undefined ? { approvedBy: args.approvedBy } : {}),
      ...(args.approvedAt !== undefined ? { approvedAt: args.approvedAt } : {}),
      ...(args.faultInjection !== undefined ? { faultInjection: args.faultInjection } : {}),
      checkPathRoot: resolveAgentWorkspaceRoot(ctx),
      actorId: identity.ownerId,
    };
    if (args.dryRun) {
      const preview = await previewAcceptanceBarAmendment(input);
      if (preview === null) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                dryRun: true,
                code: 'rubric_not_found',
                error: `no rubric '${args.rubricRef}' — rubrics:list to see refs`,
                rubricRef: args.rubricRef,
              }),
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, dryRun: true, preview }) }],
      };
    }
    const rubric = await amendRubric(input);
    if (!rubric) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `no rubric '${args.rubricRef}' — rubrics:list to see refs` }),
          },
        ],
      };
    }
    const completeness = rubricCompleteness(rubric);
    // EI-10514: schema-validate embedded replication-drill SQL against live PG (non-blocking).
    const replicationSqlCheck = await validateRubricReplicationSql(rubric.criteria);
    const methodLint =
      rubric.kind === 'acceptance' ? lintAcceptanceCriterionMethods(rubric.criteria) : [];
    // acceptance-runtime-plane P-004: same non-blocking vetting finding as rubrics:propose.
    const runtimeFindings = rubric.kind === 'acceptance' ? runtimeVettingFindings(rubric.criteria) : [];
    // Push-on-write (push-audit 2026-07-26): the Rubrics pane + trend read these.
    void trackDetached(import('../../sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('rubrics.list');
        m.notifySyncInvalidate('rubrics.trend');
      })
      .catch(() => {});
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            rubric,
            completeness,
            replicationSqlCheck,
            methodLint,
            ...(runtimeFindings.length ? { runtimeFindings } : {}),
          }),
        },
      ],
    };
  },
});
