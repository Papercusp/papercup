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
  description: 'Search work-items across kinds (feature/chunk/bug/change/task): full-text over title + body/summary FUSED (RRF) with a semantic (embedding cosine) leg, so differently-worded matches surface too (semantic:false for lexical-only). Filter by harness or kind. Use to dedup before creating. Returns { ok, count, items, legs } — NOTE the matches array is `items`, not `results` (unlike work_items:get/list, which use `results`); a code:run helper expecting `.results` on this tool silently sees [] (EI-5920). READ `legs` before concluding "no duplicate exists": legs.degraded:true means a ranking leg did not contribute (legs.warning says why, e.g. the embedder is down), so a short list may be a degraded search rather than an absence.',
  guidance: {
    when: 'You want to find existing work-items by free text (e.g. dedup before filing, or locate a known issue/feature).',
    chaining: 'work_items:search (dedup) → work_items:create, or → work_items:get { id } for detail.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  // EI-20191189382971662: searchWorkItems owns its database scopes and this
  // handler never reads ctx.tx. Do not hold the ambient workspace transaction
  // across hybrid-search awaits, or fleet load can starve the org-app pool.
  skipWorkspaceTx: true,
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
    includeObservations: z
      .boolean()
      .optional()
      .describe(
        "EI-10422: by default a payload.lane:'observation' row (a turn-end reflection / rubric scorecard filed via improvements:capture { lane:'observation' }) is EXCLUDED from matches — by design (D-005) it never enters the work queue/triage. Pass true to include raw observations in search results.",
      ),
  }),
  async handler(args) {
    const { items, legs } = await searchWorkItems(args.query, {
      harness: args.harness,
      kind: args.kind as WorkItemKind | undefined,
      limit: args.limit,
      semantic: args.semantic,
      includeObservations: args.includeObservations,
    });
    // P-016/P-020: report which ranking legs actually ran and contributed.
    // A dedup search that silently fell back to lexical-only (embedder down,
    // embeddings not backfilled) returns a plausible SHORT list and reads as
    // "no duplicate exists" — the one reading that makes this tool actively
    // harmful. `degraded` says so; the per-leg counts say why.
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, count: items.length, items, legs }) },
      ],
    };
  },
});
