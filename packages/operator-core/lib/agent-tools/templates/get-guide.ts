/**
 * templates:get-guide — read a Cupboard app-template's build knowledge (WI-3198).
 *
 * A template's correctness guarantee is by VERIFICATION not construction (plan
 * app-templates-2026-07-04 D-001): the template ships a GUIDE.md (the MUST/SHOULD/
 * FREE composition prompt), a COMPONENT_CATALOG, and a template.yaml (checks +
 * version-pinned components). This verb fetches those straight from the public
 * mirror (github_url/<ref>/…), so an MCP agent can READ how to build from a
 * template without a shell/clone. Read-only.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveTemplateListing, fetchTemplateGuide } from '../../cupboard/templates';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (status: number, error: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, status, error }) }],
});

export default defineTool({
  name: 'templates:get-guide',
  description:
    "Read a Cupboard app-template's build knowledge: its GUIDE.md (the composition prompt in MUST/SHOULD/FREE tiers) + COMPONENT_CATALOG + template.yaml (checks + pinned components), fetched from the public mirror. Pass `template` as the ref (e.g. \"papercusp-webapp\") or the listing id. Returns { ok, template:{id,ref,title,category?,scope?}, branch, guide, componentCatalog?, manifest?, guideTruncated }. This is the build-time knowledge a building agent follows — read it before templates:new-app, or to answer 'how do I build from <template>'.",
  guidance: {
    when: 'You have a template ref (from templates:list, or the user named one like "papercusp-webapp") and need to read HOW to build from it — the GUIDE.md is the composition prompt.',
    notWhen:
      'You just want to start building now → templates:new-app materializes the template AND hands the GUIDE to a builder in one step. Browsing what templates exist → templates:list.',
    chaining: 'templates:list → templates:get-guide { template } → templates:new-app { template, slug }.',
    seeAlso: ['templates:list', 'templates:new-app'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    template: z
      .string()
      .min(1)
      .max(200)
      .describe('Template listing ref (e.g. "papercusp-webapp") or listing id (uuid).'),
  }),
  async handler(args) {
    const listing = await resolveTemplateListing(args.template);
    if ('error' in listing) return fail(listing.status, listing.error);
    if (!listing.githubUrl) return fail(422, `template "${listing.ref}" has no github_url`);

    const guide = await fetchTemplateGuide({ githubUrl: listing.githubUrl, ref: listing.ref });
    if ('error' in guide) return fail(guide.status, guide.error);

    return ok({
      template: {
        id: listing.id,
        ref: listing.ref,
        title: listing.title,
        category: listing.category,
        scope: listing.scope,
        githubUrl: listing.githubUrl,
      },
      branch: guide.branch,
      guide: guide.guide,
      guideTruncated: guide.guideTruncated,
      componentCatalog: guide.componentCatalog,
      manifest: guide.manifest,
      fetchedFiles: guide.fetchedFiles,
    });
  },
});
