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

export default defineTool({
  name: 'rubrics:amend',
  profile: 'engineer',
  description:
    "Amend ONE criterion prose field (model | method | driftMarkers | replication | title) and/or set the rubric-level methodRef — the small-edit path that replaces nothing else (vs rubrics:propose's whole-document replace). mode:'append' adds a paragraph and is never guarded; mode:'replace' swaps the field and inherits the shrink loss-guard (allowMethodShrink + shrinkReason when it guts a procedure). Preserves the stored status — amending an active rubric never demotes it.",
  guidance: {
    when: "A targeted rubric improvement: fold a new replication-drill variant into one criterion, sharpen one model/driftMarkers paragraph, or point methodRef at a runbook — without resubmitting the whole document.",
    notWhen:
      'Adding/removing criteria, renaming keys, or changing rating scales — those reshape grading history: use rubrics:propose (whole-document) so the loss-guards see the full picture.',
    chaining: 'rubrics:get (read the stored field first) → rubrics:amend → the result reports `completeness` like propose/ratify.',
    seeAlso: ['rubrics:propose (whole-document revision)', 'rubrics:get (read before amending)'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    rubricId: z.string().min(1).max(120).describe('the rubric slug to amend'),
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
    methodRef: z.string().max(200).optional().describe('set/replace the agent-insights runbook slug for the rubric-level method'),
    allowMethodShrink: z
      .boolean()
      .optional()
      .describe("loss-guard ack for mode:'replace' that shrinks a procedure >40% or drops its REPLICATION DRILL marker; requires shrinkReason"),
    shrinkReason: z.string().min(1).max(2000).optional().describe('why the shrink is intentional (required with allowMethodShrink)'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const rubric = await amendRubric({
      rubricId: args.rubricId,
      ...(args.criterion ? { criterion: args.criterion } : {}),
      ...(args.methodRef !== undefined ? { methodRef: args.methodRef } : {}),
      ...(args.allowMethodShrink !== undefined ? { allowMethodShrink: args.allowMethodShrink } : {}),
      ...(args.shrinkReason !== undefined ? { shrinkReason: args.shrinkReason } : {}),
      by: id.ownerId,
    });
    if (!rubric) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: `no rubric '${args.rubricId}' — rubrics:list to see ids` }) },
        ],
      };
    }
    const completeness = rubricCompleteness(rubric);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, rubric, completeness }) }],
    };
  },
});
