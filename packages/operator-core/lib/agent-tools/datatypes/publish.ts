/**
 * datatypes:publish — offer a workspace-local datatype to the shared/global tier
 * (reflexive-platform-extensibility-datatypes-2026-06-24, D-010 shared leg).
 *
 * Marks the datatype PENDING operator moderation (`review_status: 'pending'`). Its LOCAL
 * usability is untouched — it stays usable in this workspace regardless. An operator approves
 * it before it becomes globally visible (the moderation queue + approve/reject are the
 * `*PublishedDatatypes` store primitives, run cross-workspace by the server moderation path;
 * the actual cross-machine DISTRIBUTION rides the Comb worker). Idempotent: a datatype already
 * in a publish lifecycle reports its current state rather than re-publishing.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { publishDatatype, getDatatype } from '../../datatype-registry-store';

export default defineTool({
  name: 'datatypes:publish',
  description:
    'Offer a workspace-local datatype to the shared/global tier (D-010): marks it PENDING operator ' +
    'moderation. Local usability is UNCHANGED — an operator approves it before it is globally visible. ' +
    'Idempotent: a datatype already pending/approved/rejected reports its current review_status.',
  guidance: {
    when: 'When a datatype you declared (meta:define-datatype) is worth sharing globally, not just locally — so other workspaces can discover/reuse it.',
    notWhen:
      'To declare a datatype (meta:define-datatype). To use one locally — a local datatype needs no publishing. Publishing does NOT distribute it cross-machine by itself (that rides the Comb worker once approved).',
    chaining: 'meta:define-datatype → datatypes:publish { id } → (operator moderates) → globally visible.',
    seeAlso: [
      'meta:define-datatype (define the datatype before publishing)',
      'datatypes:catalog (where the published datatype appears)',
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('the datatype id/slug to publish (from datatypes:list / datatypes:get)'),
  }),
  async handler(args, ctx) {
    const reply = (obj: unknown) => ({ data: obj });
    const sql = getOrgPg().sql;
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) {
      return reply({ ok: false, reason: 'no_workspace', message: 'no workspace in the request context' });
    }
    const existing = await getDatatype(sql, workspaceId, args.id);
    if (!existing) {
      return reply({ ok: false, reason: 'not_found', message: `no datatype "${args.id}" in this workspace — declare it first (meta:define-datatype)` });
    }
    const row = await publishDatatype(sql, workspaceId, args.id);
    if (!row) {
      // Already in a publish lifecycle (review_status != 'none').
      return reply({
        ok: true,
        id: args.id,
        reviewStatus: existing.reviewStatus,
        alreadyInPipeline: true,
        note: `"${args.id}" is already "${existing.reviewStatus}" in the publish pipeline — no change.`,
      });
    }
    return reply({
      ok: true,
      id: row.id,
      reviewStatus: row.reviewStatus,
      note:
        `"${row.id}" published — PENDING operator moderation. It stays usable locally; an operator approves it ` +
        'before it is globally visible. Cross-machine distribution rides the Comb worker once approved.',
    });
  },
});
