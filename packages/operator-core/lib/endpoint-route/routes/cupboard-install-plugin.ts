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
 * `auth: 'public'` — loopback-only via the operator's Host-header gate, like the
 * sibling cupboard routes. The Cupboard ships UNGATED (no MARKETPLACE flag).
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import { GLOBAL_PLUGINS_DIR } from '../../plugin-catalog';
import { grantCapabilities } from '../../plugin-grants';
import { resolveCupboardBaseUrl } from './harness/cupboard-publish';
import {
  installPluginFromCupboardCore,
  InstallPluginError,
  type InstallPluginCoreInput,
} from '../../cupboard/install-plugin-core';

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

async function invalidateHost(): Promise<void> {
  try {
    const { _resetPluginHostForTests } = await import('../../plugin-host-runtime');
    _resetPluginHostForTests();
  } catch { /* host runtime not initialized */ }
  try {
    const { _resetPluginApiRoutesForTests } = await import('../../plugin-api-mount');
    _resetPluginApiRoutesForTests();
  } catch { /* mount cache not initialized */ }
}

/** Resolve a Cupboard listing id → { githubUrl, listingRef } via the worker. */
async function resolveListing(id: string): Promise<{ githubUrl: string; listingRef?: string } | null> {
  const base = resolveCupboardBaseUrl();
  try {
    const res = await fetch(`${base}/listings/${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown> | null;
    const row =
      (data?.harness as Record<string, unknown> | undefined) ??
      (data?.listing as Record<string, unknown> | undefined) ??
      (data as Record<string, unknown>);
    const githubUrl = typeof row?.github_url === 'string' ? row.github_url : '';
    if (!githubUrl) return null;
    const listingRef = typeof row?.listing_ref === 'string' ? row.listing_ref : undefined;
    return { githubUrl, listingRef };
  } catch {
    return null;
  }
}

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-plugin',
  auth: 'public',
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
      const resolved = await resolveListing(String(body.listingId));
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
      const result = await installPluginFromCupboardCore(input, {
        cloneRepo: gitCloneShallow,
        globalPluginsDir: GLOBAL_PLUGINS_DIR,
        tmpDir: tmpdir,
        grant: (args) =>
          grantCapabilities({ ...args, grantedBy: 'user', reason: 'cupboard install-consent' }),
        invalidateHost,
        // Install-time dep gate (tool-distribution-granularity D-003): resolve
        // the unit's declared {tools,packs,plugins} against the live pack
        // catalog. Hard-missing deps 422 before the copy; installable ones
        // surface advisorily.
        validateDependencies: async (deps) => {
          const { validateBlueprintDependencies } = await import('@papercusp/blueprint-distribution');
          const { derivePackCatalog, depHostSetsFromCatalog } = await import('../../cupboard/pack-catalog');
          const catalog = await derivePackCatalog({});
          const verdict = validateBlueprintDependencies(deps, depHostSetsFromCatalog(catalog));
          // Mirror the harness:create gate: a transient cupboard-unreachable
          // must not hard-fail pack/plugin deps that may be installable there.
          // Tools with no provider still fail (the in-process catalog is
          // authoritative).
          if (!catalog.cupboardReachable && verdict.missing.tools.length === 0) {
            return { ...verdict, ok: true };
          }
          return verdict;
        },
      });
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
