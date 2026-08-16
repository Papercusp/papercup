/**
 * work_items:update — edit one OR many work-items' mutable fields (title / body /
 * severity / kind / found-during / linked feature / goal / plan item). The unified replacement for the
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
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { COORD_ROLES } from '../coordination/roles';
import { planItemRef, PLAN_ITEM_KIND } from '../../issue-blocks-merge';
import { updateWorkItem, mergeWorkItemPayload, explainIssueClaimFloors, linkWorkItem, unlinkWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';
import { rejectBodySummaryConflict, resolveBodyAlias } from './_body-alias';
import { unresolvedRefsInBody, unresolvedRefsWarning } from './unresolved-refs';

/**
 * EI-18707466248332421: the family-AGNOSTIC subset of this tool's fields — the ones that are
 * NOT issue-family columns but claim-ADMISSION tags on `payload`, written via
 * mergeWorkItemPayload (which supports BOTH families) instead of the updateIssue column patch.
 * Kept as ONE mapping so the issue-family path and the feature-family path below can never
 * disagree about which fields are family-agnostic.
 */
const PAYLOAD_FLAG_KEYS = {
  needsTwoMachineRig: 'needs_2_machine_rig',
  needsHuman: 'needsHuman',
} as const;

type PayloadFlagArgs = { needsTwoMachineRig?: boolean; needsHuman?: boolean };

type PlanItemArg = { slug: string; item: string };

/** Convert the public plan_item shape into the durable payload stamp read by claim specs. */
function planItemPayloadPatch(planItem: PlanItemArg | undefined, harness: string | undefined): Record<string, unknown> {
  if (!planItem || !harness) return {};
  return {
    plan_item: {
      plan_slug: planItem.slug,
      item_id: planItem.item,
      harness_slug: harness,
    },
  };
}

/** The stamp currently on the row, so a clear knows which coverage edge to retract.
 * Shaped like the DURABLE payload (plan_slug/item_id), not the public arg. */
function readExistingStamp(item: { payload?: Record<string, unknown> | null } | null): PlanItemArg | undefined {
  const stamp = item?.payload?.plan_item;
  if (!stamp || typeof stamp !== 'object') return undefined;
  const { plan_slug: slug, item_id: id } = stamp as { plan_slug?: unknown; item_id?: unknown };
  if (typeof slug !== 'string' || !slug || typeof id !== 'string' || !id) return undefined;
  return { slug, item: id };
}

/** Keep an update's plan-item coverage semantics aligned with work_items:create. */
async function linkPlanItemCoverage(
  id: string,
  planItem: PlanItemArg | undefined,
  harness: string | undefined,
  by: string,
): Promise<void> {
  if (!planItem) return;
  try {
    await linkWorkItem(
      id,
      { kind: PLAN_ITEM_KIND, ref: planItemRef(planItem.slug, planItem.item) },
      'relates',
      { harness, by },
    );
  } catch {
    // The payload stamp is the claim-admission source of truth; coverage is best-effort.
  }
}

/** Retract the coverage edge a cleared stamp had asserted, so `plan_item: null`
 * leaves no half-removed linkage behind (the payload stamp and the coverage edge
 * are written together by both create and update — they must clear together too). */
async function unlinkPlanItemCoverage(
  id: string,
  planItem: PlanItemArg | undefined,
  harness: string | undefined,
): Promise<void> {
  if (!planItem) return;
  try {
    await unlinkWorkItem(id, { kind: PLAN_ITEM_KIND, ref: planItemRef(planItem.slug, planItem.item) }, 'relates', {
      harness,
    });
  } catch {
    // Mirror the link path: the payload stamp is authoritative, coverage is best-effort.
  }
}

/** The payload patch for whichever admission flags this caller actually requested. */
function payloadFlagPatch(it: PayloadFlagArgs): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [arg, key] of Object.entries(PAYLOAD_FLAG_KEYS)) {
    const v = (it as Record<string, unknown>)[arg];
    if (v !== undefined) patch[key] = v;
  }
  return patch;
}

/** Whether the caller asked for a genuinely PIPELINE-OWNED column edit (issue-family only). */
function hasColumnEdit(it: {
  title?: unknown;
  body?: unknown;
  severity?: unknown;
  kind?: unknown;
  foundDuring?: unknown;
  linkedFeatureId?: unknown;
  parent?: unknown;
}): boolean {
  return (
    it.title !== undefined ||
    it.body !== undefined ||
    it.severity !== undefined ||
    it.kind !== undefined ||
    it.foundDuring !== undefined ||
    it.linkedFeatureId !== undefined ||
    it.parent !== undefined
  );
}

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
  parent: z.string().max(80).nullable().optional().describe('parent work-item id for duplicate/child relationships; null clears the edge'),
  // WI-37892: a goal is a shared work-item field, not issue-family metadata. Passing a
  // goal adopts an existing item into that goal's drain lane; null clears the edge.
  goal: z
    .string()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .describe('goal id to adopt this work-item into, or null to clear its goal attribution'),
  // EI-20578964155166663: `null` CLEARS the stamp, matching `parent`/`goal`. Without
  // it a stamp could be set and re-pointed but never removed, so a mis-stamped item
  // was wired into the plan's terminal machinery (lane-sync holds it at the plan
  // item's lane; completing it flips the PLAN item; reconcile then closes siblings
  // sharing the stamp) with no escape but a force-close or raw SQL. The clear is an
  // UNSET, never a null-merge — see mergeWorkItemPayload's note.
  plan_item: z
    .object({ slug: z.string().min(1), item: z.string().min(1) })
    .nullable()
    .optional()
    .describe(
      'plan item this existing work-item implements (for example { slug:"my-plan", item:"P-003" }); stamps payload.plan_item so plan-scoped fleet lanes can admit it and writes the same coverage edge as work_items:create. Pass null to CLEAR the stamp when it asserts something untrue (the item does not implement that plan item) — this removes the payload key and retracts the coverage edge, releasing the item from the plan-item lane-sync hold and the sibling-close machinery.',
    ),
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
    "Edit one OR many work-items' title/body/severity/kind/found-during/linked feature/parent/goal/plan_item/needsTwoMachineRig/needsHuman; notifies subscribers. Single: { id, …fields }; many: items:[{ id, …fields }]. Returns per-item { ok, id, item? | error }; missing items do not fail the batch. Goal and plan_item are family-agnostic; parent is the duplicate/child relation and null clears it. Other field edits are issue-family-only (bug/change/task); features remain pipeline-owned. Body shrink is rejected unless confirmShrink:true (EI-8497). needsTwoMachineRig toggles payload.needs_2_machine_rig and self-select eligibility (WI-2796); needsHuman toggles the issue review gate. (State → work_items:set_state; structural decisions → work_items:amend; tags → work_items:tag; comments → work_items:comment.)",
  guidance: {
    when: 'Refine filed work-items: clarify text, re-rate severity, correct kind (bug↔change controls lane), attach a feature, adopt/clear a goal, or backfill plan_item provenance for a plan-scoped lane. Batch via items:[…].',
    notWhen: 'Use set_state for lifecycle, amend for structural decisions, comment for notes, or tag for topics.',
    chaining: 'work_items:get → work_items:update { id, …fields }.',
    // EI-20281509195248260: `tags` is the measured case — the belief "nothing writes
    // tags" was filed 9x in 19h (see work_items/tag.ts's header) plus
    // EI-18669607533031012, because THIS tool's unrecognized-key rejection listed only
    // what it accepts and never named the writer. Costs zero prompt weight (not
    // rendered into the description) and is paid only on that failure path.
    argRedirects: {
      tags: 'work_items:tag { id, topic } — the ONLY writer for the claim-spec-visible `tags` field (it mirrors the topic into exactly what a scheduler:set_claim_spec filter on `tags` reads)',
    },
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
          'update many work-items at once — each { id, …fields }. A top-level field (title/body/severity/kind/foundDuring/linkedFeatureId/parent/goal/plan_item/harness) is the DEFAULT applied to every item that omits its own (EI-7639) — pass it once instead of repeating it per item.',
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
    // linkedFeatureId/goal/harness) is the DEFAULT for every item in items:[] that
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
          parent: it.parent !== undefined ? it.parent : args.parent,
          goal: it.goal !== undefined ? it.goal : args.goal,
          plan_item: it.plan_item !== undefined ? it.plan_item : args.plan_item,
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
            parent: args.parent,
            goal: args.goal,
            plan_item: args.plan_item,
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
            parent: it.parent,
            goal: it.goal,
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
          // EI-20189734665644353: an existing item needs a member-writable plan stamp before
          // a plan-scoped fleet claim spec can admit it. Keep the public update shape aligned
          // with work_items:create { plan_item } and preserve the coverage edge as well.
          const planHarness = resolveConcreteHarnessSlug(item.harness ?? it.harness, ctx) ?? undefined;
          if (it.plan_item === null) {
            // Clear: capture the outgoing stamp BEFORE the unset, so the coverage
            // edge it asserted can be retracted too (the payload key is gone after).
            const outgoing = readExistingStamp(item);
            const merged = await mergeWorkItemPayload(it.id, {}, { harness: it.harness, unset: ['plan_item'] });
            if (merged) item = merged;
            await unlinkPlanItemCoverage(it.id, outgoing, planHarness);
          } else {
            const planPatch = planItemPayloadPatch(it.plan_item, planHarness);
            if (Object.keys(planPatch).length > 0) {
              const merged = await mergeWorkItemPayload(it.id, planPatch, { harness: it.harness });
              if (merged) item = merged;
            }
            await linkPlanItemCoverage(it.id, it.plan_item, planHarness, ident.ownerId);
          }
          // EI-19919820196426791: raising severity to critical/major is a silent no-op on
          // claimability when the item sits in a lane the claim path structurally never
          // serves (payload.lane='observation') or is routed to a human
          // (payload.needsHuman=true) — the write reports ok:true/written:1 exactly like a
          // real steer, with nothing anywhere flagging that the two facts conflict. Surface
          // it at the write, using the SAME floor oracle the real claim path (and its own
          // miss-diagnosis) reads, so this can't drift from what scheduler:get_next actually
          // enforces.
          let claimabilityWarning: string | undefined;
          if (it.severity === 'critical' || it.severity === 'major') {
            const harnessForCheck = item.harness ?? it.harness ?? undefined;
            if (harnessForCheck) {
              try {
                const [floor] = await explainIssueClaimFloors(harnessForCheck, [it.id]);
                if (floor && (floor.refusedBy === 'observation-lane' || floor.refusedBy === 'needs-human')) {
                  claimabilityWarning =
                    `⚠ severity set to '${it.severity}', but this item is structurally UNCLAIMABLE and will stay ` +
                    `invisible to scheduler:get_next / claim_next regardless: ${floor.detail}. Raising severity ` +
                    `(or work_items:set_priority) does not change this. If it should actually be worked, clear the ` +
                    `blocking flag first — work_items:update { id, needsHuman:false } for a needs-human routing, or ` +
                    `re-file/relocate it out of the observation lane (it was captured via improvements:capture ` +
                    `{ lane:'observation' }, which by design never enters the work queue).`;
                }
              } catch {
                // Best-effort signal only — never fail the field-edit itself over it.
              }
            }
          }
          // EI-19455334047866968 / EI-20097514755548526: a work-item id written into this
          // edit is never checked for existence, so a PHANTOM ref reads identically to a
          // real one. `update` REWRITES the durable record — the same high-trust surface
          // class as `comment`/`complete`, and the version a later reader sees is this one,
          // not whatever it replaced.
          //
          // Uses the helper's DEFAULT (dynamic-import) probe rather than importing
          // getWorkItem statically: several suites here vi.mock '../../work-items' wholesale,
          // and a new static import from it is a known way to break them (EI-19395547021329946).
          // Advisory + fail-open + best-effort — the edit has already been written.
          let unresolvedRefsWarningText: string | undefined;
          try {
            const unresolved = await unresolvedRefsInBody([it.title, it.body].filter(Boolean).join('\n'), {
              known: [it.id],
            });
            if (unresolved) unresolvedRefsWarningText = unresolvedRefsWarning(it.id, unresolved.missing);
          } catch {
            /* the edit already landed — never fail it over an advisory */
          }
          return {
            ok: true as const,
            id: it.id,
            item,
            ...(claimabilityWarning ? { claimabilityWarning } : {}),
            ...(unresolvedRefsWarningText ? { unresolvedRefsWarning: unresolvedRefsWarningText } : {}),
          };
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
        // EI-18707466248332421: the rig-gate WRITE path for the FEATURE family. needsTwoMachineRig /
        // needsHuman are NOT pipeline-owned columns — they are claim-ADMISSION payload tags, and the
        // floors that READ them are ALREADY global across both families (crossMachineRigExclusionSql
        // via claimFloorsWhereSql, EI-14806); mergeWorkItemPayload likewise writes both families.
        // But this handler calls updateWorkItem FIRST unconditionally, so its issue-family-only
        // `unsupported_family` refusal short-circuited the flag merges above — leaving the global
        // read floor UNREACHABLE for a feature-family item: nothing could ARM it. So a leg the
        // repo's own committed scaffold declares rig-gated stayed claimable to every single-box cup
        // forever — WI-3500 (8 placements) + WI-3496 (6) burned 14 spawns on work no single box can
        // finish, and `state=blocked` was the only (coarse, un-re-admittable) mitigation available.
        if (res.reason === 'unsupported_family') {
          const planHarness = resolveConcreteHarnessSlug(it.harness, ctx) ?? undefined;
          const flagPatch = {
            ...payloadFlagPatch(it),
            ...planItemPayloadPatch(it.plan_item, planHarness),
          };
          // EI-20578964155166663: a clear is an UNSET, and planItemPayloadPatch emits
          // nothing for it — so without this the feature-family path would silently
          // no-op `plan_item: null` while reporting ok, the exact shape of miss this
          // fix exists to remove. Read the outgoing stamp before the unset lands.
          const clearingStamp = it.plan_item === null;
          // Dynamic import, not a new static one: several suites here vi.mock
          // '../../work-items' wholesale and a partial factory makes a newly-imported
          // name undefined at call time (EI-19395547021329946, per the note below).
          // Best-effort by design — the UNSET is the load-bearing half; retracting the
          // coverage edge is advisory, exactly as linkPlanItemCoverage already treats it.
          let outgoing: PlanItemArg | undefined;
          if (clearingStamp) {
            try {
              const { getWorkItem } = await import('../../work-items');
              outgoing = readExistingStamp(await getWorkItem(it.id, it.harness));
            } catch {
              /* leave the coverage edge; the stamp itself still clears below */
            }
          }
          if (Object.keys(flagPatch).length > 0 || clearingStamp) {
            const merged = await mergeWorkItemPayload(it.id, flagPatch, {
              harness: it.harness,
              ...(clearingStamp ? { unset: ['plan_item'] } : {}),
            });
            if (merged) {
              if (clearingStamp) await unlinkPlanItemCoverage(it.id, outgoing, planHarness);
              else await linkPlanItemCoverage(
                it.id,
                it.plan_item,
                planHarness,
                ident.ownerId,
              );
              // A column edit requested ALONGSIDE the flag genuinely IS pipeline-owned: apply the
              // admission flag (it is family-agnostic) but still report that half honestly, rather
              // than claiming the whole patch landed.
              if (!hasColumnEdit(it)) return { ok: true as const, id: it.id, item: merged };
              return {
                ok: false as const,
                id: it.id,
                error:
                  `work_item '${it.id}' is feature-family: the admission flag(s) ${Object.keys(flagPatch).join(', ')} WERE applied, ` +
                  `but its other fields are owned by the pipeline — re-send the field edit without them.`,
              };
            }
          }
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
