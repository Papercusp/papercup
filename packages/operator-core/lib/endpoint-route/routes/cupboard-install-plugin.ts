/**
 * POST /api/cupboard/install-plugin — install a plugin from the Cupboard
 * (revive-cupboard-distribution-2026-06-04 D-003 / P2). Replaces the dead
 * `:3057`/CLI tarball install (marketplace/install-plugin.ts) with a git clone
 * of the listing's GitHub repo + the existing capability-gate + install-consent
 * path (D-009).
 *
 * Body: { listingId?, githubUrl?, listingRef?, harness?, acceptCapabilities? }
 *   - listingId   resolve the repo URL + listing_ref from the Cupboard listing
 *   - githubUrl   OR install a repo directly (listingRef = plugin subdir/slug)
 *   - harness + acceptCapabilities → grant the manifest's caps for that harness
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate, like the
 * sibling cupboard routes. The Cupboard ships UNGATED (no MARKETPLACE flag).
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  installPluginFromCupboardCore,
  InstallPluginError,
  type InstallPluginCoreInput,
} from '../../cupboard/install-plugin-core';
import { buildInstallPluginDeps, resolveListingCoords } from '../../cupboard/install-io';

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-plugin',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    let body: {
      listingId?: string;
      githubUrl?: string;
      listingRef?: string;
      harness?: string;
      acceptCapabilities?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    let githubUrl = typeof body.githubUrl === 'string' ? body.githubUrl.trim() : '';
    let listingRef = typeof body.listingRef === 'string' ? body.listingRef.trim() : undefined;

    if (!githubUrl && body.listingId) {
      const resolved = await resolveListingCoords(String(body.listingId));
      if (!resolved) {
        return Response.json({ ok: false, error: 'listing_not_found_or_unreachable' }, { status: 404 });
      }
      githubUrl = resolved.githubUrl;
      listingRef = listingRef ?? resolved.listingRef;
    }
    if (!githubUrl) {
      return Response.json({ ok: false, error: 'githubUrl or listingId required' }, { status: 400 });
    }

    const input: InstallPluginCoreInput = {
      githubUrl,
      listingRef,
      harness: typeof body.harness === 'string' ? body.harness.trim() : undefined,
      acceptCapabilities: body.acceptCapabilities === true,
    };

    try {
      // Install-time dep gate (tool-distribution-granularity D-003) is wired in
      // buildInstallPluginDeps(): hard-missing deps 422 before the copy;
      // installable ones surface advisorily.
      const result = await installPluginFromCupboardCore(input, buildInstallPluginDeps());
      return Response.json(result);
    } catch (e) {
      if (e instanceof InstallPluginError) {
        return Response.json({ ok: false, error: e.message }, { status: e.status });
      }
      return Response.json(
        { ok: false, error: 'install failed', detail: e instanceof Error ? e.message.slice(0, 300) : String(e) },
        { status: 500 },
      );
    }
  },
});
