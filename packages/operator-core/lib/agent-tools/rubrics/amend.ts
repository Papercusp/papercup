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
        'preview a BAR meaning amendment without writing; returns exact approval JSON. Because coord:send expects:action caps each body at 600 characters, first persist preview.approval on the approval work-item with work_items:update { id: "<work-item-id>", payload: { acceptanceBarApproval: preview.approval } }, then send the reviewer a short coord:send pointer; the reviewer fetches work_items:get { id: "<work-item-id>", payloadTier: "full" } and posts that exact object as the entire work_items:comment body',
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
        'thread-post:<id> containing the preview approval JSON, authored by an authenticated outside-lineage reviewer',
      ),
    approvedBy: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('optional assertion of the reviewer identity; must match the approval post author'),
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
  });

export default defineTool({
  name: 'rubrics:amend',
  profile: 'engineer',
  description:
    "Amend one criterion field, bind a missing acceptance class, replace a started acceptance rubric's complete criterion set, set its structural evidence plane, or update rubric-level refs. Use complete `criteria` when adding a BAR or binding structured checks across an already-seeded contract that rubrics:propose may not replace. A started BAR meaning change uses dryRun:true to preview exact hashes. Since coord:send expects:action caps each body at 600 characters, persist the exact `preview.approval` object on the approval work-item with work_items:update { id:'<work-item-id>', payload:{ acceptanceBarApproval: preview.approval } }, send the reviewer a short coord:send pointer, and have them fetch work_items:get { id:'<work-item-id>', payloadTier:'full' } before posting the exact object as the entire work_items:comment body; then apply with approvalRef:'thread-post:<id>'. Never truncate or manually retype the approval JSON. Reviewer identity and timestamp are read from that authenticated post, never supplied by the caller. The subject Decision, every BAR/spec revision, and open-contract rebind commit atomically. Old proof and grades remain audit history but become revision-ineligible. METHOD append/replace edits retain the existing shrink guard. Stored lifecycle status is preserved.",
  guidance: {
    when: 'A targeted rubric improvement, or a complete-set revision of an already-seeded acceptance BAR contract that adds a BAR or structured checks through the atomic amendment/approval path.',
    notWhen:
      'Adding/removing criteria on a standard rubric, renaming stored keys, or changing rating scales — use rubrics:propose. Complete `criteria` here is acceptance-kind only and must preserve every stored key unless the canonical amendment rules explicitly support its removal.',
    chaining:
      "rubrics:get (read the stored field first) → rubrics:amend. For a started BAR meaning change: rubrics:amend { dryRun:true } → work_items:update { id:'<work-item-id>', payload:{ acceptanceBarApproval: preview.approval } } → coord:send a short pointer (the expects:action body cap is 600 characters) → reviewer work_items:get { id:'<work-item-id>', payloadTier:'full' } → work_items:comment with the exact approval object as the entire body → rubrics:amend { approvalRef:'thread-post:<id>' }. Never truncate or manually retype the approval JSON. The result reports `completeness` and `replicationSqlCheck` like propose/ratify.",
    seeAlso: [
      'rubrics:propose (whole-document revision)',
      'rubrics:get (read before amending)',
      'work_items:update (persist an uncapped approval payload)',
      'work_items:get (read the exact payload with payloadTier:"full")',
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
    // Push-on-write (push-audit 2026-07-26): the Rubrics pane + trend read these.
    void trackDetached(import('../../sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('rubrics.list');
        m.notifySyncInvalidate('rubrics.trend');
      })
      .catch(() => {});
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, rubric, completeness, replicationSqlCheck }) },
      ],
    };
  },
});
