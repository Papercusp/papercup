/**
 * POST /api/cupboard/install-template — install an app-template from the Cupboard
 * into the LOCAL template store (cupboard-full-dogfood-2026-07-10 P-003). The
 * template-store sibling of cupboard-install-plugin / cupboard-install-blueprint:
 * git-clone the listing's mirror repo, locate `<clone>/<listing_ref>/`, validate
 * it as a self-describing template dir, and drop it into the writable user
 * template layer so it shadows the bundled floor (resolve local→installed).
 * After install, `templates:new-app` materializes it via the same local path as a
 * bundled template — the standard-path install the templates surface was missing.
 *
 * Body: { listingId?, githubUrl?, listingRef? }
 *   - listingId  resolve the mirror repo URL + listing_ref from the Cupboard
 *                listing (kind-checked: a non-template listing is rejected 422)
 *   - githubUrl  OR install a mirror repo directly (listingRef = the template subdir)
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's
 * Host-header gate, like the sibling cupboard routes. The Cupboard ships UNGATED.
 */
import { tmpdir } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import {
  installTemplateFromCupboardCore,
  InstallTemplateError,
} from '../../cupboard/install-template-core';
import { gitCloneShallow } from '../../cupboard/install-io';
import { userTemplatesDir } from '../../cupboard/template-store';
import { resolveTemplateListing } from '../../cupboard/templates';

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-template',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    let body: {
      listingId?: string;
      githubUrl?: string;
      listingRef?: string;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    let githubUrl = typeof body.githubUrl === 'string' ? body.githubUrl.trim() : '';
    let listingRef = typeof body.listingRef === 'string' ? body.listingRef.trim() : '';

    if (!githubUrl && body.listingId) {
      const resolved = await resolveTemplateListing(String(body.listingId));
      if ('error' in resolved) {
        return Response.json({ ok: false, error: resolved.error }, { status: resolved.status });
      }
      githubUrl = resolved.githubUrl;
      if (!listingRef) listingRef = resolved.ref;
    }
    if (!githubUrl) {
      return Response.json({ ok: false, error: 'githubUrl or listingId required' }, { status: 400 });
    }
    if (!listingRef) {
      return Response.json({ ok: false, error: 'listingRef required (the template subdir)' }, { status: 400 });
    }

    try {
      const result = await installTemplateFromCupboardCore(
        { githubUrl, listingRef },
        { cloneRepo: gitCloneShallow, userTemplatesDir, tmpDir: tmpdir },
      );
      return Response.json(result);
    } catch (e) {
      if (e instanceof InstallTemplateError) {
        return Response.json({ ok: false, error: e.message }, { status: e.status });
      }
      return Response.json(
        { ok: false, error: 'install failed', detail: e instanceof Error ? e.message.slice(0, 300) : String(e) },
        { status: 500 },
      );
    }
  },
});
