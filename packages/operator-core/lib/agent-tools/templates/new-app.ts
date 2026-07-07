/**
 * templates:new-app — materialize a Cupboard app-template into a fresh coding
 * harness AND (by default) kick off a building agent seeded with the template's
 * GUIDE.md (WI-3198). The self-serve "New app from template" flow for MCP agents:
 * before this, the materializer was HTTP-only (a desktop menu action + loopback
 * route), so a shell-less agent could READ a template (templates:get-guide) but
 * had no verb to BUILD from it.
 *
 * Flow: resolve the listing → git-clone the public mirror + overlay `<ref>/` onto
 * a new harness:create'd dir (coding blueprint) → open an agent chat in the new
 * harness with the GUIDE as its brief. Composes existing tools through the
 * in-process dispatcher (harness:create, agent_chats:create/send_message), so each
 * sub-step re-runs the caller's OWN role/capability gates — a compound tool, the
 * cheap/safe complement to code:run (see _compound-dispatch.ts).
 */
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { inProcessCall, type InnerCall } from '../_compound-dispatch';
import { gitCloneShallow } from '../../cupboard/install-io';
import { papercuspRoot } from '../../papercusp-root';
import {
  resolveTemplateListing,
  fetchTemplateGuide,
  type TemplateListing,
} from '../../cupboard/templates';
import {
  materializeTemplateCore,
  MaterializeTemplateError,
  type MaterializeTemplateDeps,
  type MaterializeTemplateResult,
} from '../../cupboard/materialize-template-core';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (status: number, error: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, status, error }) }],
});

/** Compose the GUIDE.md into a builder kickoff message. */
function kickoffMessage(
  listing: TemplateListing,
  guide: string | null,
  guideTruncated: boolean,
): string {
  const head = `Build a new app from the "${listing.title}" template (ref: ${listing.ref}). Its files have been materialized into this harness — start from them.`;
  if (!guide) {
    return `${head}\n\n(The template GUIDE.md could not be pre-fetched — read GUIDE.md in the repo root, then compose the app per its MUST/SHOULD/FREE tiers.)`;
  }
  const trunc = guideTruncated
    ? '\n\n[GUIDE.md truncated here — read the full GUIDE.md in the repo for the rest.]'
    : '';
  return `${head}\n\nFollow the template's build guide below (honor its MUST/SHOULD/FREE tiers):\n\n---\n${guide}${trunc}`;
}

export interface NewAppArgs {
  template: string;
  slug: string;
  parentDir?: string;
  kickoffBuilder: boolean;
  builderRole: string;
}

export interface NewAppDeps extends MaterializeTemplateDeps {
  resolveListing: typeof resolveTemplateListing;
  fetchGuide: typeof fetchTemplateGuide;
  /** The parent dir when the caller passes none (creates it if absent). */
  defaultParentDir: () => string;
}

/**
 * Pure composition (unit-testable with a mock `inner` + mock `deps`) — mirrors
 * composeHarnessOverview. Returns a ToolResult.
 */
export async function composeNewApp(args: NewAppArgs, inner: InnerCall, deps: NewAppDeps) {
  const listing = await deps.resolveListing(args.template);
  if ('error' in listing) return fail(listing.status, listing.error);
  if (!listing.githubUrl) return fail(422, `template "${listing.ref}" has no github_url`);

  // Pre-fetch the GUIDE for the builder brief — best-effort (a miss must not block
  // materialization; the GUIDE also lands in the repo via the overlay).
  const guideRes = await deps.fetchGuide({ githubUrl: listing.githubUrl, ref: listing.ref });
  const guide = 'error' in guideRes ? null : guideRes.guide;
  const guideTruncated = 'error' in guideRes ? false : guideRes.guideTruncated;
  const guideBranch = 'error' in guideRes ? null : guideRes.branch;

  const parentDir = args.parentDir?.trim() || deps.defaultParentDir();

  let materialized: MaterializeTemplateResult;
  try {
    materialized = await materializeTemplateCore(
      {
        githubUrl: listing.githubUrl,
        ref: listing.ref,
        createHarness: async () => {
          const raw = await inner('harness:create', {
            slug: args.slug,
            parentDir,
            folderName: args.slug,
            blueprintId: 'coding',
          });
          const r = raw as { ok?: boolean; slug?: string; path?: string; error?: string };
          if (!r?.ok || !r.path || !r.slug) {
            // A THROWN sub-handler arrives as the framework's `handler_error: …`
            // PLAIN-TEXT envelope (unwrap() falls back to the raw string when the
            // payload isn't JSON). Dropping it reported an opaque "unknown error"
            // to the agent while the real cause was in the string (owner-hit
            // 2026-07-07, WI-3291 follow-up) — surface whatever we got.
            const detail =
              typeof raw === 'string'
                ? raw
                : (r?.error ?? (raw ? JSON.stringify(raw).slice(0, 300) : 'unknown error'));
            throw new MaterializeTemplateError(`harness:create failed: ${detail}`, 422);
          }
          return { slug: r.slug, path: r.path };
        },
      },
      deps,
    );
  } catch (e) {
    if (e instanceof MaterializeTemplateError) return fail(e.status, e.message);
    throw e;
  }

  // Kick off the builder (best-effort): open a role chat in the new harness + send
  // the GUIDE as its brief. A dispatch/gate failure here does NOT undo the
  // materialization — the app is created; report the builder outcome either way.
  let builder: { spawned: boolean; chatId?: string; role?: string; error?: string } = {
    spawned: false,
  };
  if (args.kickoffBuilder) {
    try {
      const chat = (await inner('agent_chats:create', {
        slug: materialized.slug,
        role: args.builderRole,
        title: `Build from template: ${listing.ref}`,
      })) as { id?: string; error?: string };
      if (!chat?.id) throw new Error(chat?.error ?? 'agent_chats:create returned no chat id');
      await inner('agent_chats:send_message', {
        slug: materialized.slug,
        chatId: chat.id,
        content: kickoffMessage(listing, guide, guideTruncated),
      });
      builder = { spawned: true, chatId: chat.id, role: args.builderRole };
    } catch (e) {
      builder = {
        spawned: false,
        role: args.builderRole,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      };
    }
  }

  return ok({
    harnessSlug: materialized.slug,
    path: materialized.path,
    filesCopied: materialized.filesCopied,
    template: { id: listing.id, ref: listing.ref, title: listing.title },
    guideBranch,
    builder,
  });
}

export default defineTool({
  name: 'templates:new-app',
  description:
    'Materialize a Cupboard app-template into a NEW coding harness and (by default) kick off a building agent seeded with the template GUIDE. Composes harness:create + agent_chats. Args: `template` (ref e.g. "papercusp-webapp" or listing id), `slug` (new harness + folder name), `parentDir?` (default <~/.papercusp>/apps), `kickoffBuilder?` (default true), `builderRole?` (default "architect"). Returns { ok, harnessSlug, path, filesCopied, template, guideBranch, builder:{spawned,chatId?} }. This is the "build from a template NOW" verb — the write complement of templates:get-guide.',
  guidance: {
    when: 'The user picked a template (from templates:list, or named one) and wants to START building the app — this scaffolds the harness AND hands the GUIDE to a builder in one call.',
    notWhen:
      'Just browsing what exists → templates:list. Only reading how a template builds (no new harness) → templates:get-guide. Creating a harness from a blueprint (not a template) → harness:create.',
    chaining: 'templates:list → templates:get-guide { template } → templates:new-app { template, slug }.',
    seeAlso: ['templates:list', 'templates:get-guide', 'harness:create'],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    template: z
      .string()
      .min(1)
      .max(200)
      .describe('Template listing ref (e.g. "papercusp-webapp") or listing id (uuid).'),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
      .describe('Slug for the new harness (also the new folder name under parentDir).'),
    parentDir: z
      .string()
      .min(1)
      .optional()
      .describe('Parent dir for the new app folder. Default: <~/.papercusp>/apps.'),
    kickoffBuilder: z
      .boolean()
      .optional()
      .default(true)
      .describe('Open a building-agent chat seeded with the GUIDE (default true). false ⇒ just materialize the files.'),
    builderRole: z
      .string()
      .min(1)
      .optional()
      .default('architect')
      .describe('Role for the builder chat (default "architect").'),
  }),
  async handler(args, ctx) {
    return composeNewApp(
      {
        template: args.template,
        slug: args.slug,
        parentDir: args.parentDir,
        kickoffBuilder: args.kickoffBuilder,
        builderRole: args.builderRole,
      },
      inProcessCall(ctx),
      {
        cloneRepo: gitCloneShallow,
        tmpDir: tmpdir,
        resolveListing: resolveTemplateListing,
        fetchGuide: fetchTemplateGuide,
        defaultParentDir: () => {
          const d = join(papercuspRoot(), 'apps');
          mkdirSync(d, { recursive: true });
          return d;
        },
      },
    );
  },
});
