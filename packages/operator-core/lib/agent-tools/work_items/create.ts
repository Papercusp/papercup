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
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { hiveArg } from '../_hive-scope';
import { createOneWorkItem, type CreateOneWorkItemArgs } from './_create-core';
import { runBulk, bulkContent } from '../_bulk';
import { hardText, LIMITS } from '../limits';

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

/** One per-item create spec — the same per-item shape as the single-call fields. */
const itemSpec = z.object({
  // Built-in kind OR a workspace-registered generic-kind datatype (P-001) — validated
  // per item in createOneWorkItem; an unregistered kind is rejected there as `unknown_kind`.
  kind: z.string().min(1).max(80).describe('built-in kind (feature, chunk, bug, change, task) OR a workspace-registered generic-kind datatype (declared via meta:define-datatype)'),
  title: hardText(LIMITS.SHORT_TITLE),
  summary: hardText(8000).optional().describe('body / summary text'),
  harness: z.string().max(80).optional().describe('harness slug — required for feature/chunk; sets scope for bug/change. Falls back to the batch `harness` default.'),
  hive: hiveArg,
  severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
  parent: z.string().max(80).optional().describe('parent work-item id (feature-family; required-shape for a chunk)'),
  topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
  payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
  urgent: z.boolean().optional().describe('URGENT enqueue: wake the brain immediately (floor-debounced). Reserve for a production fire.'),
  force: z.boolean().optional().describe('Override the EI-316 mirror-duplicate guard for this item.'),
  assign_to: z.string().max(120).optional().describe('Atomically CLAIM this item for this agent id in the SAME create (B-LOOP-4) — pass a concrete ownerId, or the literal "self" to resolve to the caller. Overrides assign_all_to_self for this item.'),
  plan_item: z
    .object({ slug: z.string().min(1), item: z.string().min(1) })
    .optional()
    .describe('Plan item this work-item ADDRESSES (e.g. { slug:"my-plan", item:"P-003" }) — writes a forward work→plan_item coverage edge so the item rolls up into that plan item and plans:items stops showing it unworked.'),
});

export default defineTool({
  name: 'work_items:create',
  profile: 'engineer',
  description:
    'Create ONE or MANY work-items of any kind — feature | chunk | bug | change | task. Returns kind-independent WI-NNN ids. bug/change/task file a tracked issue; feature/chunk enter the harness work queue. Single: { kind, title, … }. Many: items:[{ kind, title, … }] with batch-level harness / workspace / assign_all_to_self. Returns { ok, results:[{ ok, id, title, workItem } | { ok:false, title, error }], counts } — a mirror-duplicate or one bad item never fails the rest. Dedup with work_items:list/search first.',
  guidance: {
    when: 'Track a unit of work an agent will do. Pick the kind by what it IS: bug (code is broken), change (a code change / fix / refactor / DX ask — the DEFAULT for most coding work-items), feature (a pipeline-sized coding work-unit that plans into chunks), chunk (a sub-unit of a feature, pass `parent`), or task (NON-CODE work only — research a library, make a decision, a manual verification / ops step). File several at once via items:[…] instead of a round-trip each.',
    notWhen: 'NEVER use `task` for anything that edits code — that is `change` (or `feature` if pipeline-sized); `task` is non-code only. A passing question with no owner → coord:ask. A validator finding inside a live pipeline run → the validator pipeline, not here.',
    chaining: 'work_items:list (dedup) → work_items:create → work_items:claim/claim_next when you start → work_items:set_state on progress; work_items:promote to give a bug/change a pipeline run.',
    seeAlso: [
      'work_items:list (dedup against existing items before filing)',
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
      harness: z.string().max(80).optional().describe('harness slug — required for feature/chunk; sets scope for bug/change. Also the DEFAULT harness for items that omit one.'),
      hive: hiveArg,
      severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
      parent: z.string().max(80).optional().describe('parent work-item id (feature-family; required-shape for a chunk)'),
      topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
      payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
      urgent: z.boolean().optional().describe('URGENT enqueue: wake the brain immediately (floor-debounced). Reserve for a production fire, not routine filing.'),
      force: z.boolean().optional().describe('Override the EI-316 mirror-duplicate guard.'),
      assign_to: z.string().max(120).optional().describe('Atomically CLAIM the new item for this agent id in the SAME create (B-LOOP-4) — it lands already owned, no create→claim race. Omit ⇒ unclaimed.'),
      plan_item: z
        .object({ slug: z.string().min(1), item: z.string().min(1) })
        .optional()
        .describe('Plan item this work-item ADDRESSES (e.g. { slug:"my-plan", item:"P-003" }) — writes a forward work→plan_item coverage edge so the item rolls up into that plan item and plans:items stops showing it unworked.'),
      // ── bulk-create (n≥1) ──
      items: z.array(itemSpec).min(1).max(100).optional().describe('create many work-items at once — each is a full create spec.'),
      assign_all_to_self: z.boolean().optional().describe('Claim every created item for YOU (your ownerId) — unless an item carries its own assign_to.'),
      // batch-level routing default for all items
      workspace: z.string().max(120).optional().describe('target workspace id — defaults to the request workspace (MCP ?workspace=). EI-728 routing for the inline create / every item.'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.kind) && Boolean(a.title)), {
      message: 'pass { kind, title } for one, or items:[{ kind, title }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const createCtx = { ownerId: ident.ownerId, workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug };
    const list: CreateOneWorkItemArgs[] = args.items?.length
      ? args.items.map((it) => ({
          ...it,
          harness: it.harness ?? args.harness,
          workspace: args.workspace,
          assign_to: it.assign_to ?? (args.assign_all_to_self ? ident.ownerId : undefined),
          ...(it.plan_item ? { targetPlanItem: { slug: it.plan_item.slug, itemId: it.plan_item.item } } : {}),
        }))
      : [
          {
            kind: args.kind as string,
            title: args.title as string,
            summary: args.summary,
            harness: args.harness,
            hive: args.hive,
            workspace: args.workspace,
            severity: args.severity,
            parent: args.parent,
            topics: args.topics,
            payload: args.payload,
            urgent: args.urgent,
            force: args.force,
            assign_to: args.assign_to ?? (args.assign_all_to_self ? ident.ownerId : undefined),
            ...(args.plan_item ? { targetPlanItem: { slug: args.plan_item.slug, itemId: args.plan_item.item } } : {}),
          },
        ];
    const env = await runBulk(
      list,
      async (spec) => {
        const res = await createOneWorkItem(spec, createCtx);
        if (!res.ok) {
          return {
            ok: false as const,
            title: spec.title,
            error: res.error,
            ...(res.message !== undefined ? { message: res.message } : {}),
            ...(res.existing !== undefined ? { existing: res.existing } : {}),
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
        return { ok: true as const, id: res.workItem.id, title: spec.title, workItem: res.workItem, ...codeTaskWarning };
      },
      { keyOf: (spec) => ({ title: spec.title }) },
    );
    return bulkContent(env);
  },
});
