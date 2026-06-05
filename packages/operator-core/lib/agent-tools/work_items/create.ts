/**
 * work_items:create — create a work-item of any kind on the unified surface
 * (unify-work-items-2026-06-04, D-001/D-002/D-007). One `work_item` type; `kind`
 * discriminates. Mints a kind-independent WI-NNN id (D-008). Dispatches by kind:
 * bug/change file an issue (engineer_issues); feature/research-task/chunk land in
 * the harness work queue (harness_features_consolidated). A `chunk` carries a
 * `parent` (D-004).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { createWorkItem, WORK_ITEM_KINDS, type WorkItemKind } from '../../work-items';

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
  args: z.object({
    kind: z.enum([...WORK_ITEM_KINDS] as [string, ...string[]]),
    title: z.string().min(1).max(200),
    summary: z.string().max(8000).optional().describe('body / summary text'),
    harness: z.string().max(80).optional().describe('harness slug — required for feature/research-task/chunk; sets scope for bug/change'),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
    parent: z.string().max(80).optional().describe('parent work-item id (feature-family; required-shape for a chunk)'),
    topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
    payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    try {
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
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, workItem }) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }] };
    }
  },
});
