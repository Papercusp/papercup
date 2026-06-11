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
    let slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    // Under ?superuser=1 the spawn ctx supplies harnessSlug='*' as a
    // workspace-wildcard. listProjectsForHarness then tries to set
    // search_path to schema `harness_*`, which doesn't exist, and PG
    // throws `relation "harness_features" does not exist`. Treat '*'
    // the same as a missing slug — the caller has to pick a harness.
    if (slug === '*') slug = '';
    if (!slug) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'harness_slug_required: projects:list needs a specific harness. Pass {"harnessSlug":"<slug>"} (e.g. from harness:list first) or invoke from a harness-scoped spawn URL.',
        }],
      };
    }
    const projects = await listProjectsForHarness(slug);
    return { content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug, projects }) }] };
  },
});
