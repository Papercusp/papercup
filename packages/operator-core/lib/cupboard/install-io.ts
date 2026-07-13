/**
 * install-io — the REAL (git + network + host) wiring for installing a
 * Cupboard unit, shared by the install routes and the install-loop
 * (`tool-distribution-discovery-2026-06-08` P-002 / D-002).
 *
 * Both `cupboard:install-plugin` and the install-loop need the same IO: shallow
 * git-clone, the global-plugins dir, capability-grant, host-invalidate, and the
 * install-time dep-validation against the live pack catalog. This module is the
 * single source of those impls (DRY — previously inlined in the route), wrapping
 * the pure `installPluginFromCupboardCore`. A code-tool **pack** and a runtime
 * **plugin** install through the SAME core (a pack is a runtime-less plugin
 * manifest — base D-006 item 3), so one installer covers both.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { GLOBAL_PLUGINS_DIR } from '../plugin-catalog';
import { grantCapabilities } from '../plugin-grants';
import { resolveCupboardBaseUrl } from './base-url';
import {
  installPluginFromCupboardCore,
  type InstallPluginCoreDeps,
} from './install-plugin-core';
import type { InstallableUnitRef } from './resolve-and-install';

/** Shallow `git clone --depth 1 url dest`. Rejects on non-zero exit. */
export function gitCloneShallow(url: string, dest: string): Promise<void> {
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

/** Drop the in-memory plugin-host + api-route caches so a new unit goes live. */
export async function invalidatePluginHost(): Promise<void> {
  try {
    const { _resetPluginHostForTests } = await import('../plugin-host-runtime');
    _resetPluginHostForTests();
  } catch {
    /* host runtime not initialized */
  }
  try {
    const { _resetPluginApiRoutesForTests } = await import('../plugin-api-mount');
    _resetPluginApiRoutesForTests();
  } catch {
    /* mount cache not initialized */
  }
}

/** Resolve a Cupboard listing id → { githubUrl, listingRef } via the worker. */
export async function resolveListingCoords(
  id: string,
): Promise<{ githubUrl: string; listingRef?: string } | null> {
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

/**
 * Build the real `InstallPluginCoreDeps` (clone / global-plugins dir / grant /
 * host-invalidate / dep-validate-against-the-live-catalog). The dep-validator
 * mirrors the harness:create gate: a transient cupboard-unreachable must not
 * hard-fail pack/plugin deps that may be installable there; missing TOOLS still
 * fail (the in-process catalog is authoritative).
 */
export function buildInstallPluginDeps(): InstallPluginCoreDeps {
  return {
    cloneRepo: gitCloneShallow,
    globalPluginsDir: GLOBAL_PLUGINS_DIR,
    tmpDir: tmpdir,
    grant: (args) => grantCapabilities({ ...args, grantedBy: 'user', reason: 'cupboard install-consent' }),
    invalidateHost: invalidatePluginHost,
    validateDependencies: async (deps) => {
      const { validateBlueprintDependencies, resolveEventProvider } = await import('@papercusp/blueprint-distribution');
      const { derivePackCatalog, depHostSetsFromCatalog } = await import('./pack-catalog');
      const catalog = await derivePackCatalog({});
      const verdict = validateBlueprintDependencies(deps, depHostSetsFromCatalog(catalog));

      // The EVENT axis (D-003 / P-007). `validateBlueprintDependencies` covers
      // tools/packs/plugins/blueprints/datatypes — deliberately NOT events,
      // which are a UNIT-level axis, not a blueprint one. So resolve them here,
      // against the SAME derived catalog, and fold the result into the verdict.
      const missingEvents: string[] = [];
      const installableEvents: Array<{ family: string; optional?: boolean }> = [];
      const eventMessages: string[] = [];
      for (const dep of deps.events ?? []) {
        if (!dep?.family) continue;
        const r = resolveEventProvider(dep.family, catalog.view);
        if (r.status === 'available') continue;
        if (r.status === 'installable') {
          installableEvents.push({ family: dep.family, ...(dep.optional ? { optional: true } : {}) });
          continue;
        }
        // Unknown. A REQUIRED family is as hard as a missing tool; an OPTIONAL
        // one is listen-if-present and must never block the install.
        if (dep.optional) continue;
        missingEvents.push(dep.family);
        eventMessages.push(`needs event family "${dep.family}" — nothing on this host provides it`);
      }

      const merged = {
        ...verdict,
        ok: verdict.ok && missingEvents.length === 0,
        missing: { ...verdict.missing, events: missingEvents },
        installable: { ...verdict.installable, events: installableEvents },
        messages: [...verdict.messages, ...eventMessages],
      };

      // Cupboard-unreachable softening (mirrors the tool axis): a transient
      // outage can't disprove a listing, so don't hard-fail pack/plugin/event
      // deps it might have provided — but a missing TOOL still fails, because
      // the in-process catalog is authoritative for those. A missing EVENT is
      // NOT authoritative that way (a Cupboard unit we couldn't see may declare
      // it), so it softens with packs/plugins rather than failing with tools.
      if (!catalog.cupboardReachable && merged.missing.tools.length === 0) {
        return { ...merged, ok: true };
      }
      return merged;
    },
  };
}

/**
 * Install one resolved Cupboard unit (plugin or pack) by its listing id. The
 * loop-shaped return: `{ ok, declaredDeps }` surfaces the unit's OWN installable
 * deps for transitive recursion; `{ ok:false, error }` on a resolve/install
 * failure. Matches `ResolveAndInstallDeps['installUnit']`.
 */
export async function installCupboardUnitFromListing(
  unit: InstallableUnitRef,
  opts: { harness?: string; acceptCapabilities?: boolean } = {},
): Promise<
  | {
      ok: true;
      declaredDeps?: {
        tools: string[];
        packs: string[];
        plugins: string[];
        // Carries the unit's own installable EVENT deps into the loop's next
        // round, so an event dep pulls its providing Cupboard unit in exactly
        // as a tool dep does (D-003 / P-007).
        events?: Array<{ family: string; optional?: boolean }>;
      };
    }
  | { ok: false; error: string }
> {
  if (!unit.listingId) {
    return { ok: false, error: `unit "${unit.name}" has no Cupboard listing id to resolve` };
  }
  const coords = await resolveListingCoords(unit.listingId);
  if (!coords) {
    return { ok: false, error: `listing ${unit.listingId} not found or Cupboard unreachable` };
  }
  try {
    const result = await installPluginFromCupboardCore(
      {
        githubUrl: coords.githubUrl,
        listingRef: coords.listingRef,
        harness: opts.harness,
        acceptCapabilities: opts.acceptCapabilities === true,
      },
      buildInstallPluginDeps(),
    );
    return { ok: true, declaredDeps: result.installableDependencies };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
