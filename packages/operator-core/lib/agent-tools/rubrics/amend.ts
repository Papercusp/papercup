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
import { amendRubric, rubricCompleteness, AMENDABLE_CRITERION_FIELDS } from '../../rubrics';
import { validateRubricReplicationSql } from '../../rubrics-replication-sql';
import { trackDetached } from '../../detached-imports';

export default defineTool({
  name: 'rubrics:amend',
  profile: 'engineer',
  description:
    "Amend ONE criterion prose field (model | method | driftMarkers | replication | title) and/or set the rubric-level methodRef — the small-edit path that replaces nothing else (vs rubrics:propose's whole-document replace). For a started acceptance BAR, changing model/driftMarkers requires approvalRef + approvedBy from an outside-lineage reviewer and commits the subject-plan Decision, BAR/spec revisions, and open-contract rebind atomically; old evidence and grades remain auditable but become revision-ineligible. mode:'append' adds a paragraph and is never guarded; mode:'replace' swaps the field and inherits the shrink loss-guard (allowMethodShrink + shrinkReason when it guts a procedure). Preserves the stored status — amending an active rubric never demotes it.",
  guidance: {
    when: "A targeted rubric improvement: fold a new replication-drill variant into one criterion, sharpen one model/driftMarkers paragraph, or point methodRef at a runbook — without resubmitting the whole document.",
    notWhen:
      'Adding/removing criteria, renaming keys, or changing rating scales — those reshape grading history: use rubrics:propose (whole-document) so the loss-guards see the full picture.',
    chaining: 'rubrics:get (read the stored field first) → rubrics:amend → the result reports `completeness` and `replicationSqlCheck` like propose/ratify.',
    seeAlso: ['rubrics:propose (whole-document revision)', 'rubrics:get (read before amending)'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    rubricRef: z.string().min(1).max(120).describe('the rubric ref/slug to amend'),
    criterion: z
      .object({
        key: z.string().min(1).describe('the criterion key (must exist — keys are identity, not amendable)'),
        field: z.enum(AMENDABLE_CRITERION_FIELDS).describe('which prose field to patch'),
        mode: z
          .enum(['append', 'replace'])
          .describe("'append' adds text as a new paragraph (never guarded); 'replace' swaps the whole field (shrink-guarded)"),
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
    methodRef: z.string().max(200).optional().describe('set/replace the agent-insights runbook slug for the rubric-level method'),
    allowMethodShrink: z
      .boolean()
      .optional()
      .describe("loss-guard ack for mode:'replace' that shrinks a procedure >40% or drops its REPLICATION DRILL marker; requires shrinkReason"),
    shrinkReason: z.string().min(1).max(2000).optional().describe('why the shrink is intentional (required with allowMethodShrink)'),
    reason: z.string().min(1).max(4000).optional().describe('reason for a started-BAR meaning amendment; recorded on the subject-plan Decision'),
    expectedRubricRevision: z.number().int().positive().optional().describe('optimistic CAS for the acceptance-rubric plan revision'),
    expectedSubjectPlanRevision: z.number().int().positive().optional().describe('optimistic CAS for the subject-plan revision'),
    idempotencyKey: z.string().min(1).max(200).optional().describe('stable replay token for a started-BAR amendment'),
    approvalRef: z.string().min(1).max(240).optional().describe('approval event/record proving an outside-lineage reviewer approved the amendment'),
    approvedBy: z.string().min(1).max(200).optional().describe('authenticated outside-lineage approver identity'),
    approvedAt: z.string().datetime({ offset: true }).optional().describe('approval event timestamp'),
    faultInjection: z.enum(['after-decision', 'after-rubric', 'after-projection', 'after-rebind']).optional().describe('test-only rollback probe'),
  }),
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
    const rubric = await amendRubric({
      rubricId: args.rubricRef,
      ...(args.criterion ? { criterion: args.criterion } : {}),
      ...(args.criterionClass ? { criterionClass: args.criterionClass } : {}),
      ...(args.methodRef !== undefined ? { methodRef: args.methodRef } : {}),
      ...(args.allowMethodShrink !== undefined ? { allowMethodShrink: args.allowMethodShrink } : {}),
      ...(args.shrinkReason !== undefined ? { shrinkReason: args.shrinkReason } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.expectedRubricRevision !== undefined ? { expectedRubricRevision: args.expectedRubricRevision } : {}),
      ...(args.expectedSubjectPlanRevision !== undefined ? { expectedSubjectPlanRevision: args.expectedSubjectPlanRevision } : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.approvalRef !== undefined ? { approvalRef: args.approvalRef } : {}),
      ...(args.approvedBy !== undefined ? { approvedBy: args.approvedBy } : {}),
      ...(args.approvedAt !== undefined ? { approvedAt: args.approvedAt } : {}),
      ...(args.faultInjection !== undefined ? { faultInjection: args.faultInjection } : {}),
      actorId: identity.ownerId,
    });
    if (!rubric) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: `no rubric '${args.rubricRef}' — rubrics:list to see refs` }) },
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
