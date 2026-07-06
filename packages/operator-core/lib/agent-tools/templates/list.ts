/**
 * templates:list — browse the Cupboard's app-template storefront (WI-3198).
 *
 * The `templates:*` group closes the gap an agent hit live: the entire Cupboard
 * surface was HTTP-only, so an MCP agent with no shell could not discover the
 * published app-templates (plan app-templates-2026-07-04) even though the guidance
 * tells it to "reach for an app template". This is the read half — it wraps
 * GET {cupboard}/listings?kind=template. Read-only, no side effects.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { fetchCupboardTemplates } from '../../cupboard/templates';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});

export default defineTool({
  name: 'templates:list',
  description:
    'Browse the Cupboard app-template storefront — the official "Papercusp Official: …" templates a NEW app is composed from (whole-app: papercusp-webapp, desktop-app, agentic-desktop-app; aspect: data-sync, search, ui, release-pipeline, data-layer, …). Wraps GET {cupboard}/listings?kind=template. Returns { ok, reachable, count, templates:[{ id, ref, title, description, category?, scope?, githubUrl }] }. `ref` (e.g. "papercusp-webapp") is the handle you pass to templates:get-guide / templates:new-app.',
  guidance: {
    when: 'A user asks to build/scaffold an app (or "use the papercusp-webapp template") and you need to discover which official templates exist before building. The entry point to the app-template flow.',
    notWhen:
      'You already know the template ref → skip to templates:get-guide (read the build guide) or templates:new-app (materialize + start building). Installing a blueprint/plugin (that is the Cupboard install path, not a template). A plan/rubric template — that is plans:*-template-data, unrelated.',
    chaining: 'templates:list → templates:get-guide { template } → templates:new-app { template, slug }.',
    seeAlso: [
      'templates:get-guide (read a template\'s GUIDE.md + component catalog)',
      'templates:new-app (materialize a template into a fresh harness + start a builder)',
      'harness:create (create a harness from a blueprint instead of an app-template)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    q: z
      .string()
      .max(200)
      .optional()
      .describe('Optional search query forwarded to the Cupboard (matches title/description).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max templates to return (default 50).'),
  }),
  async handler(args) {
    const { reachable, templates } = await fetchCupboardTemplates({ q: args.q, limit: args.limit });
    return ok({
      reachable,
      count: templates.length,
      templates,
      ...(reachable
        ? {}
        : { note: 'Cupboard unreachable — no templates could be listed (this is NOT "none exist").' }),
    });
  },
});
