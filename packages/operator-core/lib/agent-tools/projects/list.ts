/**
 * projects:list — list projects relevant to a harness, with feature counts.
 *
 * Mirrors GET /:slug/projects under the Hono harness mount. Cross-
 * harness rows are filtered to those with at least one feature in the
 * given harness slug. Workspace-scoped via withWorkspaceLegacy().
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { listProjectsForHarness } from '../../projects-data';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'projects:list',
  profile: 'engineer',
  guidance: {
    when: 'User asks "what projects do I have?" or you need a project id before calling `projects:get`. Workspace-level project enumeration.',
    notWhen: 'For HARNESSES (work running inside a project), use `harness:list`. Projects ⊇ harnesses; the slug overlap is intentional but the surfaces are different.',
    chaining: 'Pair with `projects:get` for detail, or `projects:spec_revisions` for the spec history.',
  },
  description: 'List projects relevant to a harness (filtered to those with at least one feature in the given slug). Includes feature counts.',
  capability: 'projects:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
  }),
  async handler(args, ctx) {
    // Route through the fail-loud resolver (workspace-data-isolation-leaks P-004):
    // a missing slug, the operator/superuser `'*'` auto-default, AND an explicit
    // `all` (cross-harness scope is meaningless for a single-harness project list)
    // all resolve to null → a `harness_required` error. The old
    // `args.harnessSlug ?? ctx.harnessSlug ?? ''` guarded only by `if (!slug)` plus
    // a hand-rolled `if (slug === '*')` — which still let an explicit `all` slip
    // through to listProjectsForHarness('all'), setting search_path to a
    // nonexistent `harness_all` schema (PG: `relation "harness_features" does not
    // exist`) — a silent wrong-scope read instead of a clear, actionable error.
    const slug = resolveConcreteHarnessSlug(args.harnessSlug, ctx);
    if (!slug) {
      return harnessRequiredResult('projects:list');
    }
    const projects = await listProjectsForHarness(slug);
    return { content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug, projects }) }] };
  },
});
