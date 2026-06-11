/**
 * POST /api/cupboard/install-blueprint — install a blueprint from the Cupboard
 * (official-blueprints-cupboard-publish-2026-06-05 P-004 / D-001 / D-004).
 *
 * A `kind=blueprint` listing is GitHub-repo-backed; installing it = git-clone
 * the repo, locate `<listing_ref>/blueprint.yaml` (or the root), validate it
 * (schema + semantics + import-time dep-validation), and place the dir under
 * `~/.papercusp/blueprints/<id>/` — the middle tier of the composed
 * local → installed → built-in `extends` resolution, where it shadows the
 * bundled built-in of the same id.
 *
 * Body: { listingId?, githubUrl?, listingRef?, installPlugins? }
 *   - listingId      resolve the repo URL + listing_ref from the Cupboard listing
 *   - githubUrl      OR install a repo directly (listingRef = blueprint subdir)
 *   - installPlugins consent to auto-install the blueprint's declared plugin
 *                    deps that are resolvable from the Cupboard (D-001's
 *                    consent-gated plugin fetch)
 *
 * `auth: 'public'` — loopback-only via the operator's Host-header gate, like
 * the sibling cupboard routes.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import { parseDepSpec } from '@papercusp/blueprint-distribution';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { resolveCupboardBaseUrl } from './harness/cupboard-publish';
import { derivePackCatalog, depHostSetsFromCatalog } from '../../cupboard/pack-catalog';
import {
  installBlueprintFromCupboardCore,
  InstallBlueprintError,
} from '../../cupboard/install-blueprint-core';

function gitCloneShallow(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git clone failed (exit ${code}): ${err.slice(0, 300)}`)),
    );
  });
}

/** Resolve a Cupboard listing id → { githubUrl, listingRef }, kind-checked. */
async function resolveBlueprintListing(
  id: string,
): Promise<{ githubUrl: string; listingRef?: string } | { error: string; status: number }> {
  const base = resolveCupboardBaseUrl();
  let row: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${base}/listings/${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: 'listing_not_found_or_unreachable', status: 404 };
    const data = (await res.json()) as Record<string, unknown> | null;
    row =
      (data?.harness as Record<string, unknown> | undefined) ??
      (data?.listing as Record<string, unknown> | undefined) ??
      (data as Record<string, unknown>);
  } catch {
    return { error: 'listing_not_found_or_unreachable', status: 404 };
  }
  if (row?.listing_kind !== 'blueprint') {
    return { error: `listing is kind=${String(row?.listing_kind ?? 'unknown')}, not a blueprint`, status: 422 };
  }
  const githubUrl = typeof row.github_url === 'string' ? row.github_url : '';
  if (!githubUrl) return { error: 'listing has no github_url', status: 422 };
  const listingRef = typeof row.listing_ref === 'string' ? row.listing_ref : undefined;
  return { githubUrl, listingRef };
}

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-blueprint',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    let body: {
      listingId?: string;
      githubUrl?: string;
      listingRef?: string;
      installPlugins?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    let githubUrl = typeof body.githubUrl === 'string' ? body.githubUrl.trim() : '';
    let listingRef = typeof body.listingRef === 'string' ? body.listingRef.trim() : undefined;

    if (!githubUrl && body.listingId) {
      const resolved = await resolveBlueprintListing(String(body.listingId));
      if ('error' in resolved) {
        return Response.json({ ok: false, error: resolved.error }, { status: resolved.status });
      }
      githubUrl = resolved.githubUrl;
      listingRef = listingRef ?? resolved.listingRef;
    }
    if (!githubUrl) {
      return Response.json({ ok: false, error: 'githubUrl or listingId required' }, { status: 400 });
    }

    try {
      const result = await installBlueprintFromCupboardCore(
        { githubUrl, listingRef },
        {
          cloneRepo: gitCloneShallow,
          installedBlueprintsDir: INSTALLED_BLUEPRINTS_DIR,
          tmpDir: tmpdir,
          resolveExtends: operatorResolveExtends(),
          // The pack-catalog host sets (tool-distribution D-002): built-ins +
          // installed units + Cupboard listings, provider-aware for tools.
          resolveHostSets: async () => {
            const catalog = await derivePackCatalog({});
            return { ...depHostSetsFromCatalog(catalog), cupboardReachable: catalog.cupboardReachable };
          },
        },
      );

      // D-001's consent-gated plugin fetch: with `installPlugins: true`, install
      // each declared plugin that's resolvable from the Cupboard (not yet
      // installed). Best-effort per plugin — a failed install is reported, not
      // swallowed; the blueprint itself is already placed.
      const pluginInstalls: Array<{ plugin: string; ok: boolean; error?: string }> = [];
      if (body.installPlugins === true && (result.depCheck?.installable.plugins.length ?? 0) > 0) {
        const { installPluginFromCupboardCore } = await import('../../cupboard/install-plugin-core');
        const { GLOBAL_PLUGINS_DIR } = await import('../../plugin-catalog');
        const { grantCapabilities } = await import('../../plugin-grants');
        const base = resolveCupboardBaseUrl();
        for (const spec of result.depCheck!.installable.plugins) {
          const { name } = parseDepSpec(spec);
          try {
            // Resolve the plugin's own listing → repo URL.
            const res = await fetch(
              `${base}/listings?kind=plugin&limit=100`,
              { headers: { 'User-Agent': 'papercusp-operator/1' }, signal: AbortSignal.timeout(10_000) },
            );
            const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
            const listing = (data.results ?? []).find((l) => l.listing_ref === name);
            const url = typeof listing?.github_url === 'string' ? listing.github_url : '';
            if (!url) throw new Error('no plugin listing with that ref');
            await installPluginFromCupboardCore(
              { githubUrl: url, listingRef: name },
              {
                cloneRepo: gitCloneShallow,
                globalPluginsDir: GLOBAL_PLUGINS_DIR,
                tmpDir: tmpdir,
                grant: (args) =>
                  grantCapabilities({ ...args, grantedBy: 'user', reason: 'blueprint dep install-consent' }),
                invalidateHost: async () => {
                  try {
                    const { _resetPluginHostForTests } = await import('../../plugin-host-runtime');
                    _resetPluginHostForTests();
                  } catch { /* host runtime not initialized */ }
                },
              },
            );
            pluginInstalls.push({ plugin: name, ok: true });
          } catch (e) {
            pluginInstalls.push({ plugin: name, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
          }
        }
      }

      return Response.json({ ...result, pluginInstalls });
    } catch (e) {
      if (e instanceof InstallBlueprintError) {
        return Response.json({ ok: false, error: e.message }, { status: e.status });
      }
      return Response.json(
        { ok: false, error: 'install failed', detail: e instanceof Error ? e.message.slice(0, 300) : String(e) },
        { status: 500 },
      );
    }
  },
});
