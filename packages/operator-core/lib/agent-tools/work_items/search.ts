/**
 * work_items:search — cross-kind full-text search over the unified surface
 * (parity with issues:search / features search). Searches both kind-tables and
 * merges the matches; filter by harness / kind.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { searchWorkItems, type WorkItemKind } from '../../work-items';

export default defineTool({
  name: 'work_items:search',
  profile: 'engineer',
  description: 'Search work-items across kinds (feature/chunk/bug/change/task): full-text over title + body/summary PLUS a semantic (embedding cosine) leg, so differently-worded matches surface too (P-008; semantic:false for lexical-only). Filter by harness or kind. Use to dedup before creating. Returns { ok, count, items } — NOTE the matches array is `items`, not `results` (unlike work_items:get/list, which use `results`); a code:run helper expecting `.results` on this tool silently sees [] (EI-5920).',
  guidance: {
    when: 'You want to find existing work-items by free text (e.g. dedup before filing, or locate a known issue/feature).',
    chaining: 'work_items:search (dedup) → work_items:create, or → work_items:get { id } for detail.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    query: z.string().min(1).max(400),
    harness: z.string().max(80).optional(),
    // P-001/P-011 generic-kind: a built-in kind OR a workspace-registered generic-kind
    // datatype. familyOf() routes it to the feature family + featureFamilyKindClause admits
    // it, so the filter works; an unknown kind simply yields no matches. Enum-locking this
    // blocked filtering search by a declared datatype. Mirrors work_items:create.
    kind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'built-in kind (feature, chunk, bug, change, task) OR a workspace-registered generic-kind datatype',
      ),
    limit: z.number().int().positive().max(200).optional(),
    semantic: z
      .boolean()
      .optional()
      .describe('default true: merge embedding-cosine hits after the lexical ones (fail-open). false = lexical-only.'),
  }),
  async handler(args) {
    const items = await searchWorkItems(args.query, {
      harness: args.harness,
      kind: args.kind as WorkItemKind | undefined,
      limit: args.limit,
      semantic: args.semantic,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: items.length, items }) }] };
  },
});
