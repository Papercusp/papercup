/**
 * plans:revision-diff — unified diff between a revision and its
 * predecessor, sourced from the plan_revisions snapshot pair.
 *
 * plan-agent-launch-2026-05-21, Phase 4 (P-018).
 *
 * Sources the patch from the two content_snapshot rows — no git
 * shell-out or working-tree coupling. Reads two rows in one query
 * (getPlanRevisionPairById).
 *
 * - seq 1 returns the file-against-empty patch (the original creation
 *   diff) — older is null.
 * - Unknown revisionId returns error: 'unknown_revision'.
 * - DB failure returns error: 'revision_diff_unavailable'.
 *
 * Output is a standard unified-diff string consumable by
 * react-diff-view's parseDiff.
 */

import { createPatch } from 'diff';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { getPlanRevisionPairById, getPlanRevisionSnapshot, type PlanRevisionPair } from './revisions';

const argsSchema = z.object({
  // z.coerce so the same schema accepts a numeric MCP arg AND a
  // string from `?revisionId=…` on the admin route.
  revisionId: z.coerce
    .number()
    .int()
    .positive()
    .describe('The plan_revisions row id (from plans:revisions.id) to diff against its predecessor.'),
  harness: harnessArg,
  comparison: z.object({ auditSeq: z.number().int().positive(),
    cursor: z.object({ basis: z.string().regex(/^[0-9a-f]{64}$/), after: z.string().min(1) }).strict().optional(),
    limit: z.number().int().min(1).max(1000).optional() }).strict().optional()
    .describe('Continue the exact activation-audit comparison returned by an ordinary plan edit.'),
});

class MissingRevisionPredecessor extends Error {
  constructor(readonly edition: PlanRevisionPair['newer']) {
    super(`Revision ${edition.seq - 1} of ${edition.planSlug} is unavailable. Restore that exact snapshot and retry the comparison with revision ${edition.seq}.`);
  }
}

/**
 * Build the unified-diff string for one revision pair.
 * Only the creation revision is compared with an empty document. Retention
 * can leave a later edition readable after its predecessor is unavailable.
 */
export function buildRevisionDiffText(pair: PlanRevisionPair): string {
  if (pair.newer.seq > 1 && pair.older?.seq !== pair.newer.seq - 1) {
    throw new MissingRevisionPredecessor(pair.newer);
  }
  const filename = `${pair.newer.planSlug}.md`;
  const olderLabel = pair.older ? `revision #${pair.older.seq}` : '(empty)';
  const newerLabel = `revision #${pair.newer.seq}`;
  return createPatch(
    filename,
    pair.older?.contentSnapshot ?? '',
    pair.newer.contentSnapshot,
    olderLabel,
    newerLabel,
  );
}

export default defineTool({
  name: 'plans:revision-diff',
  description:
    'Unified diff between a plan revision and its immediate predecessor, sourced from PG-canonical plan_revisions snapshots. Seq 1 returns the creation diff. A missing predecessor returns revision_predecessor_unavailable with the required sequence and exact retry.',
  guidance: {
    when: 'You have a revisionId from plans:revisions and want the patch — what exactly changed in that revision.',
    notWhen:
      'You want the revision list — plans:revisions. You want the authoring conversation — plans:revision-transcript. You want the current plan body — plans:get.',
    chaining: 'plans:revisions → plans:revision-diff { revisionId } for any revision.',
    seeAlso: [
      'plans:revisions (list revisions)',
      'plans:revision-transcript (the authoring transcript for context)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    try {
      // Workspace scope: revision rows are RLS-isolated per workspace
      // (audit P-008 / mig 218); resolve it from the harness arg.
      const harnessSlug = resolveCtxHarnessSlug(harnessScopedCtx(args.harness, ctx));
      const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
      const pair = await getPlanRevisionPairById(args.revisionId, { workspaceId: scope.workspaceId });
      if (!pair) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'unknown_revision',
                revisionId: args.revisionId,
              }),
            },
          ],
          isError: true,
        };
      }
      if (args.comparison) {
        const target = pair.newer;
        const { compareActivationAuditTargets, getLatestActivationAudit } = await import('../../plan-audits');
        const audit = target.harnessSlug === scope.harnessSlug
          ? await getLatestActivationAudit(target.planSlug, { ...scope, auditSeq: args.comparison.auditSeq }) : null;
        if (!audit?.auditedPlanRevision || !target.contentHash || audit.auditedPlanRevision.seq > target.seq) {
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'comparison_unavailable',
            coverage: 'unknown', recovery: { tool: 'plans:revision-diff', args } }) }] };
        }
        const original = await getPlanRevisionSnapshot(target.planSlug, audit.auditedPlanRevision.seq, { ...scope, exactBody: true });
        const affectedTargets = compareActivationAuditTargets({ audit, revision: { id: target.id, seq: target.seq,
          contentHash: target.contentHash }, currentContent: target.contentSnapshot,
          auditedContent: original?.id === audit.auditedPlanRevision.id ? original.contentSnapshot : null,
          cursor: args.comparison.cursor, limit: args.comparison.limit });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ slug: target.planSlug, seq: target.seq, affectedTargets }) }] };
      }
      const diff = buildRevisionDiffText(pair);
      ctxAny.metadata?.({
        slug: pair.newer.planSlug,
        revisionId: args.revisionId,
        seq: pair.newer.seq,
        diffBytes: diff.length,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              diff,
              slug: pair.newer.planSlug,
              seq: pair.newer.seq,
              priorSeq: pair.older?.seq ?? null,
            }),
          },
        ],
      };
    } catch (e) {
      if (e instanceof MissingRevisionPredecessor) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({
          error: 'revision_predecessor_unavailable', message: e.message,
          revisionId: args.revisionId, slug: e.edition.planSlug, seq: e.edition.seq,
          coverage: 'unknown', missingSeq: e.edition.seq - 1,
          recovery: { tool: 'plans:revision-diff', args },
        }) }] };
      }
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'revision_diff_unavailable',
              message: message.slice(0, 400),
              revisionId: args.revisionId,
            }),
          },
        ],
        isError: true,
      };
    }
  },
});
