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
import { clampText, hardText, softText, LIMITS } from '../limits';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { updateWorkItem, mergeWorkItemPayload } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';
import { rejectBodySummaryConflict, resolveBodyAlias } from './_body-alias';

const FIELDS = {
  title: hardText(LIMITS.SHORT_TITLE).optional(),
  body: hardText(8000).optional(),
  // WI-4492: `summary` is an ACCEPTED ALIAS for `body` — the SAME column. work_items:get
  // and work_items:create both name this field `summary`, so a get→edit→update (or a
  // create-then-update) round-trip used to write the text under a name update silently
  // dropped. Accept either; `rejectBodySummaryConflict` rejects both-with-different-values.
  summary: hardText(8000).optional().describe('alias for `body` — the item’s main text (work_items:get/create name it `summary`). Pass either; both-with-different-values is rejected (WI-4492).'),
  severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
  kind: z
    .enum(['bug', 'change'])
    .optional()
    .describe('correct a mislabeled work-item kind — bug = broken (auto-implement-eligible), change = desired improvement (human-gated)'),
  // EI-10943 (same trap as improvements:capture): a provenance LABEL must never bounce
  // the whole update on length. Soft-capped — truncated handler-side by `clampText`,
  // never rejected. (Handler-side, not a zod .transform(): a transform crashes
  // z.toJSONSchema for the entire catalog — see limits.ts.)
  foundDuring: softText(LIMITS.LABEL).nullable().optional(),
  linkedFeatureId: z.string().max(80).nullable().optional(),
  confirmShrink: z
    .boolean()
    .optional()
    .describe(
      "EI-8497: a `body` edit that would replace a substantial existing body with something far shorter is REJECTED by default (a fat-finger guard — there's no body revision history to recover from a mis-call). Pass true to confirm a genuinely intended drastic shrink.",
    ),
  // EI-18151406094317010: tag/untag an item as needing a live ≥2-machine (Hetzner/
  // federation) rig to actually execute. scheduler:get_next / claim_next then EXCLUDE
  // it from single-box self-select (crossMachineRigExclusionSql) — without this, a
  // single-box fleet can only discover a rig-only item by claiming then releasing it,
  // which re-fires work-item:claimable and wakes every idle member on every churn
  // cycle. Sets/clears payload.needs_2_machine_rig; not a real column, so it's applied
  // via mergeWorkItemPayload rather than the updateIssue column patch.
  needsTwoMachineRig: z
    .boolean()
    .optional()
    .describe(
      'WI-2796: mark (true) or unmark (false) this item as requiring a live ≥2-machine / Hetzner federation rig to work — scheduler:get_next / claim_next then exclude it from single-box self-select instead of letting single-box agents claim-then-release it repeatedly (EI-18151406094317010). Sets payload.needs_2_machine_rig.',
    ),
  // work-item-claimability-clarity-2026-07-20 P-004: the RE-ADMIT lever. Sets/clears
  // payload.needsHuman — the SAME human-review gate improvements:resolve sets when routing an
  // item to a human. Clearing it (false) re-admits an over-flagged agent-fixable bug back into
  // scheduler:get_next / claim_next self-select — the canonical, tool-mediated replacement for the
  // raw `mergeIssuePayload(id,{needsHuman:false})` SQL a re-admit used to require. Applied via
  // mergeWorkItemPayload (not a real column), exactly like needsTwoMachineRig above.
  needsHuman: z
    .boolean()
    .optional()
    .describe(
      'work-item-claimability-clarity P-004: mark (true) or CLEAR (false) payload.needsHuman — the human-review gate improvements:resolve sets. Clearing re-admits an over-flagged agent-fixable bug into scheduler:get_next / claim_next self-select (the re-admit lever — no raw SQL). Reserve true for a GENUINE human-capability need (owner-decision / credential / physical-device), not an auto-implement failure.',
    ),
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
  // WI-4492: strict so an unknown field name is a LOUD error naming it, never a silent
  // drop. STATE_FOOTGUN_FIELDS are DECLARED (as z.unknown) so strict lets them through to
  // the superRefine, which rejects them with a pointer to set_state (better than a generic
  // "unrecognized key"). Same for the body/summary alias.
  .strict()
  .superRefine((it, ctx) => {
    rejectStateFootguns(it, ctx);
    rejectBodySummaryConflict(it, ctx);
  });

export default defineTool({
  name: 'work_items:update',
  profile: 'engineer',
  description:
    "Edit one OR many work-items' title / body / severity / kind / found-during / linked feature / needsTwoMachineRig / needsHuman. Notifies subscribers. Single: { id, …fields }. Many heterogeneous: items:[{ id, …fields }]. Returns { ok, results:[{ ok, id, item? | error }], counts } — correlate by id; a not-found item never fails the rest. Field-edit is issue-family only (bug/change/task); a feature-family item edits via its pipeline. A `body` edit that would drastically shrink a substantial existing body is rejected unless confirmShrink:true (EI-8497 fat-finger guard). `needsTwoMachineRig:true/false` sets/clears payload.needs_2_machine_rig, which excludes/re-admits the item from single-box scheduler:get_next/claim_next self-select (WI-2796). `needsHuman:true/false` sets/clears payload.needsHuman, the issue-family human-review gate. (State → work_items:set_state; structural decisions → work_items:amend; tags → work_items:tag; comments → work_items:comment.)",
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
    .strict()
    .superRefine((a, ctx) => {
      if (!((a.items?.length ?? 0) > 0 || Boolean(a.id))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pass { id, …fields } for one, or items:[{ id, …fields }] for many',
        });
      }
      rejectStateFootguns(a, ctx);
      rejectBodySummaryConflict(a, ctx);
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
          // WI-4492: resolve body from either alias (per-item), then the top-level default.
          body: resolveBodyAlias(it) ?? resolveBodyAlias(args),
          severity: it.severity ?? args.severity,
          kind: it.kind ?? args.kind,
          foundDuring: clampText(
            it.foundDuring !== undefined ? it.foundDuring : args.foundDuring,
            LIMITS.LABEL,
          ),
          linkedFeatureId: it.linkedFeatureId !== undefined ? it.linkedFeatureId : args.linkedFeatureId,
          confirmShrink: it.confirmShrink ?? args.confirmShrink,
          needsTwoMachineRig: it.needsTwoMachineRig !== undefined ? it.needsTwoMachineRig : args.needsTwoMachineRig,
          // WI-5689: needsHuman was declared in the zod schema + documented, but never
          // threaded into `list` (nor applied in the handler below) — a genuine dead
          // field that always resolved to `undefined` regardless of caller input, so
          // work_items:update{needsHuman:true} was a silent no-op that still returned
          // ok:true. Wire it exactly like the sibling needsTwoMachineRig flag.
          needsHuman: it.needsHuman !== undefined ? it.needsHuman : args.needsHuman,
          harness: it.harness ?? args.harness,
        }))
      : [
          {
            id: args.id as string,
            title: args.title,
            body: resolveBodyAlias(args), // WI-4492: `summary` is an accepted alias for `body`
            severity: args.severity,
            kind: args.kind,
            foundDuring: clampText(args.foundDuring, LIMITS.LABEL),
            linkedFeatureId: args.linkedFeatureId,
            confirmShrink: args.confirmShrink,
            needsTwoMachineRig: args.needsTwoMachineRig,
            needsHuman: args.needsHuman, // WI-5689
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
            confirmShrink: it.confirmShrink,
          },
          ident.ownerId,
          { harness: it.harness },
        );
        if (res.ok) {
          let item = res.item;
          // EI-18151406094317010: needsTwoMachineRig isn't a real issue column, so it's
          // applied additively via mergeWorkItemPayload rather than the updateIssue patch
          // above (which would silently drop an unknown key).
          if (it.needsTwoMachineRig !== undefined) {
            const merged = await mergeWorkItemPayload(
              it.id,
              { needs_2_machine_rig: it.needsTwoMachineRig },
              { harness: it.harness },
            );
            if (merged) item = merged;
          }
          // WI-5689: needsHuman is likewise not a real column — apply it the same way,
          // via mergeWorkItemPayload (re-fetches so the echoed `item` reflects the
          // write, not a stale pre-merge snapshot).
          if (it.needsHuman !== undefined) {
            const merged = await mergeWorkItemPayload(it.id, { needsHuman: it.needsHuman }, { harness: it.harness });
            if (merged) item = merged;
          }
          return { ok: true as const, id: it.id, item };
        }
        if (res.reason === 'body_shrink_guard') {
          return {
            ok: false as const,
            id: it.id,
            error: `work_item '${it.id}' body edit REJECTED (EI-8497 fat-finger guard): the existing body is ${res.existingLength} chars and the new one is only ${res.newLength} — a >85% shrink. If this is genuinely intended, resend with confirmShrink:true.`,
          };
        }
        if (res.reason === 'remote_origin_not_editable') {
          return {
            ok: false as const,
            id: it.id,
            error:
              `work_item '${it.id}' is remote-authored (origin=remote) and cannot be field-edited locally; ` +
              `its authoring peer owns the row and this node receives updates through federation. ` +
              `(work_items:get / work_items:comment still work on it — only field-edit is blocked.)`,
          };
        }
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
