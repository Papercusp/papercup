/**
 * work_items:update — edit one OR many work-items' mutable fields (title / body /
 * severity / kind / found-during / linked feature). The unified replacement for the
 * retired issues:update. Subscribers are notified. State → work_items:set_state;
 * structural decisions → work_items:amend; tags → work_items:tag; comments →
 * work_items:comment.
 *
 * Field-edit is an ISSUE-FAMILY capability (bug | change | task): a feature-family
 * item's fields are owned by the pipeline (scoper/architect), so editing one returns
 * a typed `unsupported_family` error rather than silently no-op'ing.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): edit ONE inline
 * ({ id, ...fields }) or MANY heterogeneous (items:[{ id, ...fields }]) → { ok,
 * results:[{ ok, id, item? | error }], counts }. Each result self-describes its id;
 * one not-found item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { updateWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const FIELDS = {
  title: hardText(LIMITS.SHORT_TITLE).optional(),
  body: hardText(8000).optional(),
  severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
  kind: z
    .enum(['bug', 'change'])
    .optional()
    .describe('correct a mislabeled work-item kind — bug = broken (auto-implement-eligible), change = desired improvement (human-gated)'),
  foundDuring: z.string().max(120).nullable().optional(),
  linkedFeatureId: z.string().max(80).nullable().optional(),
};

// EI-6060: `status` / `state` are NOT update fields — a work-item's lifecycle state
// changes through work_items:set_state, not here. Zod's default object() SILENTLY
// STRIPS any unknown key, so `update({ id, state:'resolved' })` parsed clean, ran the
// handler with every field undefined, and returned ok:true with an UNCHANGED item — a
// silent no-op the caller reads as success (the exact reported defect). Capture the two
// footgun keys explicitly so a superRefine can ERROR with a pointer to set_state instead
// of stripping them. (status/state are `unknown` because ANY provided value is a misuse.)
const STATE_FOOTGUN_FIELDS = {
  status: z.unknown().optional(),
  state: z.unknown().optional(),
};

function rejectStateFootguns(a: { status?: unknown; state?: unknown }, ctx: z.RefinementCtx): void {
  if (a.status !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message:
        'work_items:update does not change status — use work_items:set_state { id, state } (issue-family: open|resolved|closed; feature-family: passed|failing|deprecated|…).',
    });
  }
  if (a.state !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'work_items:update does not change lifecycle state — use work_items:set_state { id, state }.',
    });
  }
}

const itemSpec = z
  .object({
    id: z.string().min(1),
    harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
    ...FIELDS,
    ...STATE_FOOTGUN_FIELDS,
  })
  .superRefine(rejectStateFootguns);

export default defineTool({
  name: 'work_items:update',
  profile: 'engineer',
  description:
    "Edit one OR many work-items' title / body / severity / kind / found-during / linked feature. Notifies subscribers. Single: { id, …fields }. Many heterogeneous: items:[{ id, …fields }]. Returns { ok, results:[{ ok, id, item? | error }], counts } — correlate by id; a not-found item never fails the rest. Field-edit is issue-family only (bug/change/task); a feature-family item edits via its pipeline. (State → work_items:set_state; structural decisions → work_items:amend; tags → work_items:tag; comments → work_items:comment.)",
  guidance: {
    when: 'Refine work-item(s) you or someone else filed — clarify the title/body, re-rate severity, correct a mislabeled kind (bug↔change — the kind picks the auto-implement lane, so keep it honest), or attach the feature that will fix it. Edit several at once via items:[…].',
    notWhen: 'Changing lifecycle state (work_items:set_state), recording a structural decision like split/drop (work_items:amend), adding a note (work_items:comment), or routing to a topic (work_items:tag).',
    chaining: 'work_items:get → work_items:update { id, …fields }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-update shorthand: the work-item id'),
      ...FIELDS,
      ...STATE_FOOTGUN_FIELDS,
      items: z
        .array(itemSpec)
        .min(1)
        .max(200)
        .optional()
        .describe(
          'update many work-items at once — each { id, …fields }. A top-level field (title/body/severity/kind/foundDuring/linkedFeatureId/harness) is the DEFAULT applied to every item that omits its own (EI-7639) — pass it once instead of repeating it per item.',
        ),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
    })
    .superRefine((a, ctx) => {
      if (!((a.items?.length ?? 0) > 0 || Boolean(a.id))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pass { id, …fields } for one, or items:[{ id, …fields }] for many',
        });
      }
      rejectStateFootguns(a, ctx);
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // EI-7639: a top-level field-edit (title/body/severity/kind/foundDuring/
    // linkedFeatureId/harness) is the DEFAULT for every item in items:[] that
    // omits its own — previously it was silently dropped in the batch form (the
    // per-item value was used even when `undefined`, so a top-level `kind` with
    // items:[{id}, …] applied NO kind change while still reporting ok:true and
    // bumping updated_ts). `foundDuring`/`linkedFeatureId` are nullable, so an
    // explicit `null` on the item (clear the field) must NOT be overridden by
    // the top-level default — only a truly-omitted (`undefined`) field falls
    // back.
    const list = args.items?.length
      ? args.items.map((it) => ({
          id: it.id,
          title: it.title ?? args.title,
          body: it.body ?? args.body,
          severity: it.severity ?? args.severity,
          kind: it.kind ?? args.kind,
          foundDuring: it.foundDuring !== undefined ? it.foundDuring : args.foundDuring,
          linkedFeatureId: it.linkedFeatureId !== undefined ? it.linkedFeatureId : args.linkedFeatureId,
          harness: it.harness ?? args.harness,
        }))
      : [
          {
            id: args.id as string,
            title: args.title,
            body: args.body,
            severity: args.severity,
            kind: args.kind,
            foundDuring: args.foundDuring,
            linkedFeatureId: args.linkedFeatureId,
            harness: args.harness,
          },
        ];
    const env = await runBulk(
      list,
      async (it) => {
        const res = await updateWorkItem(
          it.id,
          {
            title: it.title,
            body: it.body,
            severity: it.severity,
            kind: it.kind,
            foundDuring: it.foundDuring,
            linkedFeatureId: it.linkedFeatureId,
          },
          ident.ownerId,
          { harness: it.harness },
        );
        if (res.ok) return { ok: true as const, id: it.id, item: res.item };
        return {
          ok: false as const,
          id: it.id,
          error:
            res.reason === 'unsupported_family'
              ? `work_item '${it.id}' is feature-family — its fields are owned by the pipeline; field-edit applies to issue-family items (bug/change/task)`
              : `work_item '${it.id}' not found`,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
