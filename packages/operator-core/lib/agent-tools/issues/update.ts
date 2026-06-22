/**
 * issues:update — edit one OR many issues' mutable fields (engineer-issues-2026-06-03,
 * Phase 1). Subscribers are notified. State changes go through issues:close;
 * tags through issues:tag; comments through issues:comment.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): edit ONE inline
 * ({ id, ...fields }) or MANY heterogeneous (items:[{ id, ...fields }]) → { ok,
 * results:[{ ok, id, issue? | error }], counts }. (No homogeneous `ids` form — the
 * edited fields are per-item.) Each result self-describes its id; one not-found
 * item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { updateIssue } from '../../issues-engineer';
import { runBulk, bulkContent } from '../_bulk';

const FIELDS = {
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(8000).optional(),
  severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
  kind: z.enum(['bug', 'change']).optional().describe('correct a mislabeled work-item kind — bug = broken (auto-implement-eligible), change = desired improvement (human-gated)'),
  foundDuring: z.string().max(120).nullable().optional(),
  linkedFeatureId: z.string().max(80).nullable().optional(),
};

const itemSpec = z.object({ id: z.string().min(1), ...FIELDS });

export default defineTool({
  name: 'issues:update',
  profile: 'engineer',
  description:
    "Edit one OR many issues' title / body / severity / kind / found-during / linked feature. Notifies subscribers. Single: { id, …fields }. Many heterogeneous: items:[{ id, …fields }]. Returns { ok, results:[{ ok, id, issue? | error }], counts } — correlate by id; a not-found item never fails the rest. (State → issues:close; tags → issues:tag; comments → issues:comment.)",
  guidance: {
    when: 'Refine issue(s) you or someone else filed — clarify the title/body, re-rate severity, correct a mislabeled kind (bug↔change — the kind picks the auto-implement lane, so keep it honest), or attach the feature that will fix it. Edit several at once via items:[…].',
    notWhen: 'Resolving it (issues:close), adding a note (issues:comment), or routing it to a topic (issues:tag).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-update shorthand: the issue id'),
      ...FIELDS,
      items: z.array(itemSpec).min(1).max(200).optional().describe('update many issues at once — each { id, …fields }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id, …fields } for one, or items:[{ id, …fields }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : [{ id: args.id as string, title: args.title, body: args.body, severity: args.severity, kind: args.kind, foundDuring: args.foundDuring, linkedFeatureId: args.linkedFeatureId }];
    const env = await runBulk(
      list,
      async (it) => {
        const issue = await updateIssue(it.id, {
          title: it.title,
          body: it.body,
          severity: it.severity,
          kind: it.kind,
          foundDuring: it.foundDuring,
          linkedFeatureId: it.linkedFeatureId,
          by: ident.ownerId,
        });
        return issue
          ? { ok: true as const, id: it.id, issue }
          : { ok: false as const, id: it.id, error: 'issue not found' };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
