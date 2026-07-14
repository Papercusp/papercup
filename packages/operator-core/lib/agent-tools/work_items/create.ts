/**
 * work_items:create — create a work-item of any kind on the unified surface
 * (unify-work-items-2026-06-04, D-001/D-002/D-007). One `work_item` type; `kind`
 * discriminates. Mints a kind-independent WI-NNN id (D-008). Dispatches by kind:
 * bug/change/task file an issue (engineer_issues); feature/chunk land in
 * the harness work queue (harness_features_consolidated). A `chunk` carries a
 * `parent` (D-004).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): create ONE inline
 * ({ kind, title, … }) or MANY (items:[{ kind, title, … }] + batch-level harness /
 * workspace / assign_all_to_self) → { ok, results:[{ ok, id, title, workItem } |
 * { ok:false, title, error, message?, existing? }], counts }. This RETIRES the old
 * `work_items:create_batch` multiplexer (D-002): every item still runs the SAME
 * per-item core (`createOneWorkItem`) — the EI-316 mirror-guard, EI-728 workspace
 * resolution, the D-019/D-020 hive-scope gate, and the B-LOOP-4 atomic create+claim.
 *
 * Emits (start-hive-wake-orchestration-2026-06-09 P-001 / D-001): a successful
 * create fires a `coord:emit` lifecycle notification scoped to the item's tagged
 * topics — new demand surfaces as an event. With the bulk envelope it fires PER
 * created item via the D-007 event-layer fan-out (so a bulk create no longer
 * silently drops the demand signal — D-003). The Queen's default wake subscription
 * rides the same tool event (lib/hive/wake-defaults), per item; the `urgent` flag
 * remains the immediate-bypass (requestUrgentHiveWake) for fire-now cases.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { hiveArg } from '../_hive-scope';
import { createOneWorkItem, type CreateOneWorkItemArgs } from './_create-core';
import { TERMINAL_WORK_ITEM_STATES } from '../../work-items';
import { LINK_RELS } from './link';
import { runBulk, bulkContent } from '../_bulk';
import { hardText, LIMITS } from '../limits';
import { rejectBodySummaryConflict, resolveBodyAlias } from './_body-alias';
import {
  admitSubjectForFleetTarget,
  notifyFleetScopeRefusal,
} from '../../scheduler/fleet-scope-admission';
import type { ClaimSpecSubject } from '../../scheduler/claim-spec-match';
import { ROUTING_GATE_INTENTS } from '../../routing-gate-hints';

/**
 * Inline typed-link spec (WI-3956) — one edge written from the NEW work-item to a
 * target right after creation. Shared by the single-create args and the bulk itemSpec
 * so the shape never drifts. `rel` is pinned to the LINK_RELS vocabulary (imported
 * from the link tool — one source of truth); the target is another work-item
 * (target_id) or any coord ObjectRef (target_kind + target_ref). Best-effort in the
 * core: an unresolvable target is skipped, never failing the create.
 */
/**
 * EI-10897 — the `state` you may set AT CREATION.
 *
 * Non-terminal only, and deliberately so. Creating an item straight into a terminal
 * state would walk right past the completion-integrity gate (setWorkItemState /
 * setIssueState demand an owner + a completionRef for any terminal transition, and
 * `audit:'no-evidence'` reads the evidence that gate collects) — i.e. it would be a
 * one-call way to manufacture a "done" item with no evidence, the exact laundering
 * EI-10867 exists to stop. If it is genuinely already finished, create it and then
 * work_items:complete it, so the evidence is recorded.
 */
const stateOnCreate = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => !TERMINAL_WORK_ITEM_STATES.includes(s), {
    message:
      'a work-item cannot be CREATED in a terminal state — that would bypass the completion-integrity gate (no owner, no evidence). Create it, then work_items:complete { id, completion, state } so the verification evidence is recorded.',
  })
  .describe(
    "initial lifecycle state (EI-10897) — e.g. 'wip' to open an ad-hoc unit you are starting RIGHT NOW (pair with assign_to:'self'), or 'blocked'. Defaults to the kind's normal entry state (todo). Terminal states are rejected: complete the item instead, so its evidence is recorded.",
  );

const linkSpec = z.object({
  rel: z.enum(LINK_RELS).describe('the relationship: blocks | relates | duplicates | fixes | investigates | about | caused-by | revises'),
  target_id: z.string().max(120).optional().describe('a target work-item id'),
  target_kind: z.string().max(40).optional().describe('explicit coord ObjectRef kind (e.g. plan_item, event) — use with target_ref'),
  target_ref: z.string().max(160).optional().describe('explicit coord ObjectRef ref — use with target_kind'),
  target_harness: z.string().max(80).optional().describe('harness for a feature target_id (disambiguation)'),
});

function rejectMissingScheduleCadence(
  value: { routing_intent?: string; cadence?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.routing_intent === 'schedule-recurrence' && !value.cadence?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['cadence'],
      message:
        "cadence is required when routing_intent='schedule-recurrence' — e.g. 'daily at 09:00' or a cron expression",
    });
  }
}

/**
 * Heuristic: does this work-item text smell like CODE work? Used ONLY for a
 * NON-BLOCKING nudge when kind='task' (which is non-code only, WI-2874). A false
 * positive is harmless — it's a suggestion the creator can ignore — so we bias
 * toward a few reliable STRUCTURAL signals (a repo source path, a code file
 * extension, a backticked camelCase identifier) plus a short set of code-edit
 * verbs, rather than a fragile generic-verb net. Pure + exported for its test.
 */
export function codeSmellsLikeCode(title: string, summary?: string): boolean {
  const text = `${title ?? ''}\n${summary ?? ''}`;
  return (
    /\b(packages|libs|apps|src|scripts)\/[\w./-]+/i.test(text) || // a repo source path
    /\.(ts|tsx|rs|mjs|cjs|js|jsx|sql|py|go|sh)\b/.test(text) || // a code file extension
    /`[^`]*[a-z][A-Z][^`]*`/.test(text) || // a backticked camelCase identifier
    /\b(implement|refactor|re-?kind|patch|hotfix|typecheck|recompile|null-?check|regression test|stack ?trace|zod schema|unit test|integration test|code path|endpoint|migration)\b/i.test(
      text,
    )
  );
}

function createAdmissionSubject(spec: CreateOneWorkItemArgs): ClaimSpecSubject {
  const payload = spec.payload ?? {};
  const numberOrNull = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    // An id-pinned fleet is a closed cohort: a not-yet-minted item cannot be
    // silently placed into it merely because its eventual WI id is unknown.
    id: null,
    title: spec.title,
    kind: spec.kind,
    priority: null,
    tags: spec.topics ?? [],
    paths: Array.isArray(payload.paths) ? payload.paths.filter((p): p is string => typeof p === 'string') : [],
    plan: spec.targetPlanItem?.slug ?? null,
    planItem: spec.targetPlanItem ? [spec.targetPlanItem.itemId] : [],
    age: Date.now(),
    riskTier: typeof payload.risk_tier === 'string' ? payload.risk_tier : null,
    redundancy: numberOrNull(payload.redundancy),
    estCost: numberOrNull(payload.est_cost ?? payload.expected_cost_cents),
    assignee: spec.assign_to ?? null,
  };
}

/** One per-item create spec — the same per-item shape as the single-call fields. */
const itemSpec = z.object({
  // Built-in kind OR a workspace-registered generic-kind datatype (P-001) — validated
  // per item in createOneWorkItem; an unregistered kind is rejected there as `unknown_kind`.
  kind: z.string().min(1).max(80).describe('built-in kind (feature, chunk, bug, change, task) OR a workspace-registered generic-kind datatype (declared via meta:define-datatype)'),
  title: hardText(LIMITS.SHORT_TITLE),
  summary: hardText(8000).optional().describe('body / summary text'),
  // WI-4492: `body` is an ACCEPTED ALIAS for `summary` (the SAME field). work_items:update
  // names it `body`, so a caller who learned that name used to have it silently dropped here.
  body: hardText(8000).optional().describe('alias for `summary` — the item body text (work_items:update names it `body`). Pass either; both-with-different-values is rejected (WI-4492).'),
  harness: z.string().max(80).optional().describe('harness slug — required for feature/chunk; sets scope for bug/change. Falls back to the batch `harness` default.'),
  pot: hiveArg,
  severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
  parent: z.string().max(80).optional().describe('parent work-item id (feature-family; required-shape for a chunk)'),
  topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
  payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
  routing_intent: z.enum(ROUTING_GATE_INTENTS).optional().describe('explicit papercusp-way routing intent. Body/summary prose is never classified. schedule-recurrence also requires cadence.'),
  cadence: hardText(200).optional().describe('explicit cadence for routing_intent=schedule-recurrence, e.g. "daily at 09:00" or a cron expression'),
  urgent: z.boolean().optional().describe('URGENT enqueue: wake the brain immediately (floor-debounced). Reserve for a production fire.'),
  force: z.boolean().optional().describe('Override the EI-316 mirror-duplicate guard for this item.'),
  assign_to: z.string().max(120).optional().describe('Atomically CLAIM this item for this agent id in the SAME create (B-LOOP-4) — pass a concrete ownerId, or the literal "self" to resolve to the caller. Overrides assign_all_to_self for this item.'),
  // EI-10897: the su persona itself documents `work_items:create { title, assign_to:'self',
  // state:'wip' }` as THE way to open an ad-hoc unit you are starting right now — and the
  // tool rejected `state` as an unrecognized key. A prompt that teaches an arg the tool
  // refuses is a contract break; the arg is cheaper to add than the instruction is to
  // unteach. Terminal states are refused on purpose (see stateOnCreate below).
  state: stateOnCreate.optional(),
  plan_item: z
    .object({ slug: z.string().min(1), item: z.string().min(1) })
    .optional()
    .describe('Plan item this work-item ADDRESSES (e.g. { slug:"my-plan", item:"P-003" }) — writes a forward work→plan_item coverage edge so the item rolls up into that plan item and plans:items stops showing it unworked.'),
  links: z.array(linkSpec).max(20).optional().describe('inline typed links (WI-3956) written from the new item to targets on create — e.g. [{ rel:"investigates", target_id:"EI-9250" }]. Best-effort: a bad target is skipped, never fails the create.'),
})
  // WI-4492: strict — an unknown field name is a LOUD error naming it, never a silent drop
  // (the defect that filed WI-4491/WI-4492 as empty shells: a `body` arg was stripped).
  .strict()
  .superRefine(rejectBodySummaryConflict)
  .superRefine(rejectMissingScheduleCadence);

export default defineTool({
  name: 'work_items:create',
  profile: 'engineer',
  description:
    'Create ONE or MANY work-items. bug/change/task file tracked issues; feature/chunk enter the harness queue. If creation atomically assigns to a fleet MEMBER, the synthetic new item must match that member\'s claim spec or creation is refused before mutation; unassigned creation is unchanged. Single: { kind, title, … }; many: items:[…]. Returns per-item outcomes.',
  guidance: {
    when: 'Track a unit of work an agent will do. Pick the kind by what it IS: bug (code is broken), change (a code change / fix / refactor / DX ask — the DEFAULT for most coding work-items), feature (a pipeline-sized coding work-unit that plans into chunks), chunk (a sub-unit of a feature, pass `parent`), or task (NON-CODE work only — research a library, make a decision, an ops step). A suspected bug is filed (kind:bug) the MOMENT you notice it — filing is unconditional; fixing is the judgment call. File several at once via items:[…]; inline links:[{ rel, target_id }] beats a follow-up link call.',
    notWhen: 'NEVER use `task` for anything that edits code — that is `change` (or `feature` if pipeline-sized); `task` is non-code only. A passing question with no owner → coord:ask. A validator finding inside a live pipeline run → the validator pipeline, not here.',
    chaining: 'work_items:list (dedup) → work_items:create → work_items:claim/claim_next when you start → work_items:set_state on progress; work_items:promote to give a bug/change a pipeline run.',
    seeAlso: [
      'work_items:list (dedup against existing items before filing)',
      'work_items:link (add typed edges to an EXISTING item — create’s links:[…] is the at-birth shorthand)',
      'work_items:promote (give a filed bug/change a pipeline run)',
      'work_items:claim (self-assign the new item at creation via { assignee })',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // New demand surfaces as an EVENT (start-hive-wake P-001 / D-001). Scoped to the
  // item's tagged topics ([] when untagged ⇒ a recorded lifecycle row with no inbox
  // delivery). Fires PER created item through the D-007 fan-out (the per-item event's
  // result.data is { ok, workItem, … } and args carries that item's `topics`).
  emits: [
    {
      fire: 'coord:emit',
      when: (e) => Boolean((e.result?.data as { ok?: boolean } | undefined)?.ok),
      render: (e) => {
        const data = e.result.data as {
          workItem?: { id?: string; kind?: string; title?: string; harness?: string | null };
        };
        const wi = data.workItem ?? {};
        const topics = Array.isArray((e.args as { topics?: unknown }).topics)
          ? ((e.args as { topics: string[] }).topics)
          : [];
        return {
          category: 'demand',
          summary: `work item created: ${wi.id ?? '?'} (${wi.kind ?? '?'}) — ${wi.title ?? ''}`,
          ...(wi.harness ? { body: `harness: ${wi.harness}` } : {}),
          to: topics.map((t) => `@topic:${t}`),
        };
      },
    },
  ],
  args: z
    .object({
      // ── single-create shorthand (n=1) ──
      // Built-in kind OR a workspace-registered generic-kind datatype — validated in
      // createOneWorkItem (P-001). Relaxed from z.enum so a registered kind passes; an
      // unregistered one is rejected there with `unknown_kind` (was a zod enum error).
      kind: z.string().min(1).max(80).optional().describe('built-in kind (feature, chunk, bug, change, task) OR a workspace-registered generic-kind datatype (declared via meta:define-datatype)'),
      title: hardText(LIMITS.SHORT_TITLE).optional(),
      summary: hardText(8000).optional().describe('body / summary text'),
      body: hardText(8000).optional().describe('alias for `summary` — the item body text (work_items:update names it `body`). Pass either; both-with-different-values is rejected (WI-4492).'),
      harness: z.string().max(80).optional().describe('harness slug — required for feature/chunk; sets scope for bug/change. Also the DEFAULT harness for items that omit one.'),
      pot: hiveArg,
      severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
      parent: z.string().max(80).optional().describe('parent work-item id (feature-family; required-shape for a chunk)'),
      topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
      payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
      routing_intent: z.enum(ROUTING_GATE_INTENTS).optional().describe('explicit papercusp-way routing intent. Body/summary prose is never classified. schedule-recurrence also requires cadence.'),
      cadence: hardText(200).optional().describe('explicit cadence for routing_intent=schedule-recurrence, e.g. "daily at 09:00" or a cron expression'),
      urgent: z.boolean().optional().describe('URGENT enqueue: wake the brain immediately (floor-debounced). Reserve for a production fire, not routine filing.'),
      force: z.boolean().optional().describe('Override the EI-316 mirror-duplicate guard.'),
      assign_to: z.string().max(120).optional().describe('Atomically CLAIM the new item for this agent id in the SAME create (B-LOOP-4) — pass a concrete ownerId, or the literal "self" to resolve to the caller. Omit ⇒ unclaimed.'),
      state: stateOnCreate.optional(), // EI-10897
      plan_item: z
        .object({ slug: z.string().min(1), item: z.string().min(1) })
        .optional()
        .describe('Plan item this work-item ADDRESSES (e.g. { slug:"my-plan", item:"P-003" }) — writes a forward work→plan_item coverage edge so the item rolls up into that plan item and plans:items stops showing it unworked.'),
      links: z.array(linkSpec).max(20).optional().describe('inline typed links (WI-3956) written from the new item to targets on create — e.g. [{ rel:"investigates", target_id:"EI-9250" }]. Best-effort: a bad target is skipped, never fails the create.'),
      // ── bulk-create (n≥1) ──
      items: z.array(itemSpec).min(1).max(100).optional().describe('create many work-items at once — each is a full create spec.'),
      assign_all_to_self: z.boolean().optional().describe('Claim every created item for YOU (your ownerId) — unless an item carries its own assign_to.'),
      // batch-level routing default for all items
      workspace: z.string().max(120).optional().describe('target workspace id — defaults to the request workspace (MCP ?workspace=). EI-728 routing for the inline create / every item.'),
    })
    // WI-4492: strict so an unknown field name (e.g. a stripped `body`) is a LOUD error.
    .strict()
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.kind) && Boolean(a.title)), {
      message: 'pass { kind, title } for one, or items:[{ kind, title }] for many',
    })
    .superRefine(rejectBodySummaryConflict)
    .superRefine(rejectMissingScheduleCadence),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const createCtx = { ownerId: ident.ownerId, workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug };
    const list: CreateOneWorkItemArgs[] = args.items?.length
      ? args.items.map((it) => {
          // WI-4492: `body` is an accepted alias for `summary`. Drop the raw `body` key
          // (createOneWorkItem takes `summary`) and resolve the single value from either.
          const { body: _body, ...rest } = it;
          return {
            ...rest,
            summary: resolveBodyAlias(it),
            harness: it.harness ?? args.harness,
            workspace: args.workspace,
            assign_to: resolveSelfLiteral(it.assign_to, ident.ownerId) ?? (args.assign_all_to_self ? ident.ownerId : undefined),
            ...(it.plan_item ? { targetPlanItem: { slug: it.plan_item.slug, itemId: it.plan_item.item } } : {}),
            ...(it.links ? { links: it.links } : {}),
          };
        })
      : [
          {
            kind: args.kind as string,
            title: args.title as string,
            summary: resolveBodyAlias(args), // WI-4492: `body` is an accepted alias for `summary`
            harness: args.harness,
            pot: args.pot,
            workspace: args.workspace,
            severity: args.severity,
            parent: args.parent,
            topics: args.topics,
            payload: args.payload,
            routing_intent: args.routing_intent,
            cadence: args.cadence,
            state: args.state, // EI-10897
            urgent: args.urgent,
            force: args.force,
            assign_to: resolveSelfLiteral(args.assign_to, ident.ownerId) ?? (args.assign_all_to_self ? ident.ownerId : undefined),
            ...(args.plan_item ? { targetPlanItem: { slug: args.plan_item.slug, itemId: args.plan_item.item } } : {}),
            ...(args.links ? { links: args.links } : {}),
          },
        ];
    const env = await runBulk(
      list,
      async (spec) => {
        if (spec.assign_to) {
          const admission = await admitSubjectForFleetTarget({
            target: spec.assign_to,
            subject: createAdmissionSubject(spec),
            workspaceId: ident.workspaceId,
          });
          if (!admission.allowed) {
            await notifyFleetScopeRefusal(
              ident,
              admission,
              `work_items:create+assign '${spec.title}' → ${spec.assign_to}`,
            );
            return {
              ok: false as const,
              title: spec.title,
              error: admission.code,
              message: `${admission.reason}. The item was not created, so no out-of-scope claim exists.`,
            };
          }
        }
        const res = await createOneWorkItem(spec, createCtx);
        if (!res.ok) {
          return {
            ok: false as const,
            title: spec.title,
            error: res.error,
            ...(res.message !== undefined ? { message: res.message } : {}),
            ...(res.existing !== undefined ? { existing: res.existing } : {}),
            // P-008: duplicate_semantic carries the cosine-matched OPEN items.
            ...(res.similarOpen !== undefined ? { similarOpen: res.similarOpen } : {}),
          };
        }
        // WI-2874 non-blocking nudge: `task` is NON-CODE only. If a fresh task smells
        // like code, attach a warning (never block) so the creator can re-kind it.
        const codeTaskWarning =
          spec.kind === 'task' && codeSmellsLikeCode(spec.title, spec.summary)
            ? {
                warning:
                  'This looks like CODE work, but `task` is NON-CODE only (research / a decision / manual verification / ops). If it edits code, re-kind to `change` (or `feature` if pipeline-sized) via work_items:update.',
              }
            : {};
        return {
          ok: true as const,
          id: res.workItem.id,
          title: spec.title,
          workItem: res.workItem,
          ...codeTaskWarning,
          // P-008 soft-band advisory: created fine, but these OPEN items are
          // semantically close — check them before splitting the work.
          ...(res.similarOpen !== undefined ? { similarOpen: res.similarOpen } : {}),
        };
      },
      { keyOf: (spec) => ({ title: spec.title }) },
    );
    // Create-time dedup port (memory-delivery-unification-2026-07-12 P-009 /
    // D-006): the work-items-corpus leg already ships as `similarOpen` (the
    // semantic-dupe guard); this is the MEMORY-POOLS leg — surface fuzzy prior
    // knowledge about what's being filed, at exactly the moment a duplicate
    // could be created. Deadline-bounded, epoch-deduped (port 'create'),
    // never-throws. Queries the item titles + summaries (top 3 per D-005).
    const memory = await import('../../memory/claim-port')
      .then((m) =>
        m.buildClaimRecallBlock({
          sessionId: ident.ownerId,
          workspaceId: ctx.workspaceId ?? null,
          items: list.map((s) => ({
            id: s.title,
            title: s.title,
            summary: s.summary,
            harness: s.harness ?? ctx.harnessSlug ?? null,
          })),
          port: 'create',
          heading:
            'Related prior knowledge (fuzzy memory — check before filing: we may already know about this)',
        }),
      )
      .catch(() => null);
    return bulkContent(memory ? { ...env, memory } : env);
  },
});
