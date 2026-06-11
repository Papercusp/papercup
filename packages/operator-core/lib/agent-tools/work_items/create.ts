/**
 * work_items:create — create a work-item of any kind on the unified surface
 * (unify-work-items-2026-06-04, D-001/D-002/D-007). One `work_item` type; `kind`
 * discriminates. Mints a kind-independent WI-NNN id (D-008). Dispatches by kind:
 * bug/change file an issue (engineer_issues); feature/research-task/chunk land in
 * the harness work queue (harness_features_consolidated). A `chunk` carries a
 * `parent` (D-004).
 *
 * Emits (start-hive-wake-orchestration-2026-06-09 P-001 / D-001): a successful
 * create fires a `coord:emit` lifecycle notification scoped to the item's tagged
 * topics — new demand surfaces as an event. The Queen's default wake
 * subscription rides the same tool event (lib/hive/wake-defaults); the `urgent`
 * flag remains the immediate-bypass (requestUrgentHiveWake) for fire-now cases.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { createWorkItem, getWorkItem, WORK_ITEM_KINDS, type WorkItemKind } from '../../work-items';
import { findMirroredOpenItem } from './mirror-guard';

export default defineTool({
  name: 'work_items:create',
  profile: 'engineer',
  description:
    'Create a work-item of any kind — feature | research-task | chunk | bug | change. Returns a kind-independent WI-NNN id. bug/change file a tracked issue; feature/research-task/chunk enter the harness work queue (feature/research-task pickable by the pipeline; chunk is an execution sub-unit carrying a parent). Dedup with work_items:list/search first.',
  guidance: {
    when: 'You want to track a unit of work an agent will do. Pick the kind: bug (something broken), change (a desired one-off / DX ask), feature (a pipeline work-unit), research-task, or chunk (a sub-unit of a parent, pass `parent`).',
    notWhen: 'A passing question with no owner → coord:ask. A validator finding inside a live pipeline run → the validator pipeline, not here.',
    chaining: 'work_items:list (dedup) → work_items:create → work_items:claim when you start → work_items:set_state on progress; work_items:promote to give a bug/change a pipeline run.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // New demand surfaces as an EVENT (start-hive-wake P-001 / D-001). Scoped to
  // the item's tagged topics ([] when untagged ⇒ the lifecycle row is recorded
  // with no inbox delivery — the audit value without fleet-wide noise; the
  // Queen's wake rides the tool event itself, not this message).
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
  args: z.object({
    kind: z.enum([...WORK_ITEM_KINDS] as [string, ...string[]]),
    title: z.string().min(1).max(200),
    summary: z.string().max(8000).optional().describe('body / summary text'),
    harness: z.string().max(80).optional().describe('harness slug — required for feature/research-task/chunk; sets scope for bug/change'),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
    parent: z.string().max(80).optional().describe('parent work-item id (feature-family; required-shape for a chunk)'),
    topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
    payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
    urgent: z
      .boolean()
      .optional()
      .describe(
        'URGENT enqueue: wake the brain (Pot operator) immediately instead of its slow cadence (floor-debounced — a burst coalesces to one wake). Reserve for genuinely-urgent work (a production fire), not routine filing.',
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        'Override the mirror-duplicate guard (EI-316): create even when the title embeds an existing OPEN work-item id. Only set this when the reference is deliberate, not when you mean to work the referenced item.',
      ),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    try {
      // EI-316 mirror-duplicate guard: a title embedding an existing OPEN
      // work-item id ("WI-118: …") is almost always an accidental mirror — the
      // creator should work the given id, not fork a duplicate it then completes
      // while the original strands in `validating`. Refuse with the live id
      // (override: force:true). Flag-gated so a misfire is instantly reversible.
      if (!args.force && (await getFlag(FLAGS.WORK_ITEM_MIRROR_GUARD, 'system'))) {
        const mirror = await findMirroredOpenItem(args.title, async (id) => {
          const wi = await getWorkItem(id, args.harness);
          return wi ? { id: wi.id, state: wi.state } : null;
        });
        if (mirror) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'duplicate_mirror',
                  message:
                    `title references existing OPEN work-item ${mirror.id} (state: ${mirror.state}) — ` +
                    `work that item directly (work_items:claim ${mirror.id} / work_items:set_state), do NOT create a mirror. ` +
                    `Pass force:true only if this reference is deliberate.`,
                  existing: mirror,
                }),
              },
            ],
          };
        }
      }
      const workItem = await createWorkItem({
        kind: args.kind as WorkItemKind,
        title: args.title,
        summary: args.summary,
        harness: args.harness,
        severity: args.severity,
        parent: args.parent,
        topics: args.topics,
        payload: args.payload,
        createdBy: ident.ownerId,
        urgent: args.urgent,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, workItem }) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }] };
    }
  },
});
