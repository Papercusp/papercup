/**
 * install-blueprint-io — the REAL (git + network + resolver) wiring + the
 * dep-closure orchestration for installing a Cupboard blueprint.
 *
 * Extracted (cupboard-agent-tool-coverage-2026-07-14 P-005, D-001 reuse-first)
 * from the inline body of `endpoint-route/routes/cupboard-install-blueprint.ts`
 * so BOTH the loopback HTTP route AND the agent-callable
 * `cupboard:install-blueprint` tool run the exact same logic — no fork.
 *
 * A `kind=blueprint` listing is GitHub-repo-backed; installing it = git-clone the
 * repo, locate `<listing_ref>/blueprint.yaml` (or the root), validate it, and
 * place the dir under `~/.papercusp/blueprints/<id>/`. With `installPlugins:true`
 * the blueprint's declared, Cupboard-resolvable plugin deps auto-install
 * (consent-gated); a blueprint declaring `dependencies.blueprints` pulls each
 * declared work-blueprint that is Cupboard-resolvable and not already present
 * (blueprint-role-bundling P-007 closure). Both closures are best-effort per
 * unit — a failure is reported, not swallowed.
 */
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { parseDepSpec } from '@papercusp/blueprint-distribution';
import { parse as parseYaml } from 'yaml';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../blueprint/installed-blueprints';
import { resolveCupboardBaseUrl } from './base-url';
import { derivePackCatalog, depHostSetsFromCatalog } from './pack-catalog';
import {
  installBlueprintFromCupboardCore,
  InstallBlueprintError,
  type InstallBlueprintCoreDeps,
  type InstallBlueprintCoreResult,
} from './install-blueprint-core';
import { gitCloneShallow, buildInstallPluginDeps } from './install-io';
import {
  BlueprintLifecycleError,
  rollbackBlueprintRelease,
  uninstallBlueprintRelease,
  type BlueprintActivationLayer,
} from './blueprint-release';

export interface InstallBlueprintFromCupboardInput {
  /** Resolve the repo URL + listing_ref from the Cupboard listing. */
  listingId?: string;
  /** OR install a repo directly (listingRef = blueprint subdir). */
  githubUrl?: string;
  listingRef?: string;
  /** Consent to auto-install the blueprint's Cupboard-resolvable plugin deps. */
  installPlugins?: boolean;
  /** Omit for the ordinary latest install. Update installs the latest listed
   *  release; rollback/uninstall operate only on immutable local history. */
  operation?: 'install' | 'update' | 'rollback' | 'uninstall';
  /** Required for rollback/uninstall, where no listing fetch is needed. */
  blueprintId?: string;
  /** Version or package content hash previously installed here. */
  targetVersion?: string;
  /** Combined install-and-activate preflight: ids already chosen for the stack.
   *  The actual desired/applied transition remains the P-040 activation door. */
  activationStack?: string[];
}

export interface InstallBlueprintClosureResult extends InstallBlueprintCoreResult {
  pluginInstalls: Array<{ plugin: string; ok: boolean; error?: string }>;
  blueprintInstalls: Array<{ blueprint: string; ok: boolean; error?: string }>;
}

export type InstallBlueprintFromCupboardResult =
  | { ok: true; result: InstallBlueprintClosureResult | Awaited<ReturnType<typeof rollbackBlueprintRelease>> | Awaited<ReturnType<typeof uninstallBlueprintRelease>> }
  | { ok: false; status: number; error: string; detail?: string };

/** Resolve a Cupboard listing id → { githubUrl, listingRef }, kind-checked. */
async function resolveBlueprintListing(
  id: string,
): Promise<{
  githubUrl: string;
  listingRef?: string;
  releaseVersion?: string;
  releaseContentHash?: string;
} | { error: string; status: number }> {
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
  const releaseVersion = typeof row.release_version === 'string' ? row.release_version : undefined;
  const releaseContentHash = typeof row.release_content_hash === 'string' ? row.release_content_hash : undefined;
  return { githubUrl, listingRef, releaseVersion, releaseContentHash };
}

function activationLayers(ids: readonly string[] | undefined): BlueprintActivationLayer[] {
  if (!ids?.length) return [];
  const resolver = operatorResolveExtends();
  return [...new Set(ids)].map((id) => {
    const file = resolver(id);
    if (!file) throw new InstallBlueprintError(`activation stack blueprint "${id}" is not installed`, 422);
    const raw = parseYaml(readFileSync(file, 'utf8')) as { slots?: Array<{ slot?: unknown }> } | null;
    const slots = (raw?.slots ?? []).flatMap((entry) => typeof entry.slot === 'string' ? [entry.slot] : []);
    return { id, slots };
  });
}

/** Fetch the set of Cupboard blueprint listing refs — the dep-validator's
 *  `cupboardBlueprints` host set + the spawned-blueprint install closure. Empty
 *  set on any error (offline → conservative). Exported for reuse by other
 *  installers that also drive `installBlueprintFromCupboardCore` (bundle-app
 *  install-io.ts's blueprint leg, D-001 reuse-first). */
export async function fetchCupboardBlueprintIds(): Promise<Set<string>> {
  try {
    const base = resolveCupboardBaseUrl();
    const res = await fetch(`${base}/listings?kind=blueprint&limit=100`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return new Set(
      (data.results ?? []).map((l) => (typeof l.listing_ref === 'string' ? l.listing_ref : '')).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Install-core deps (clone + dirs + resolver + host sets), shared by the
 *  top-level install and the recursive spawned-blueprint closure install so both
 *  resolve `dependencies.blueprints` against the same built-in/installed/Cupboard
 *  tiers (blueprint-role-bundling P-007). */
function makeInstallCoreDeps(): InstallBlueprintCoreDeps {
  return {
    cloneRepo: gitCloneShallow,
    installedBlueprintsDir: INSTALLED_BLUEPRINTS_DIR,
    tmpDir: tmpdir,
    resolveExtends: operatorResolveExtends(),
    resolveHostSets: async () => {
      const catalog = await derivePackCatalog({});
      const cupboardBlueprints = await fetchCupboardBlueprintIds();
      return { ...depHostSetsFromCatalog(catalog), cupboardBlueprints, cupboardReachable: catalog.cupboardReachable };
    },
  };
}

/**
 * The ONE orchestrated path that installs a blueprint from the Cupboard by
 * listing id OR direct github url, running the plugin + spawned-blueprint dep
 * closures. Never throws for an expected failure; the caller maps status+error.
 */
export async function installBlueprintFromCupboard(
  input: InstallBlueprintFromCupboardInput,
): Promise<InstallBlueprintFromCupboardResult> {
  const operation = input.operation ?? 'install';
  if (operation === 'rollback' || operation === 'uninstall') {
    const id = input.blueprintId?.trim() ?? '';
    if (!id) return { ok: false, status: 400, error: `blueprintId required for ${operation}` };
    try {
      if (operation === 'uninstall') {
        return { ok: true, result: await uninstallBlueprintRelease({ installedDir: INSTALLED_BLUEPRINTS_DIR(), id }) };
      }
      const target = input.targetVersion?.trim() ?? '';
      if (!target) return { ok: false, status: 400, error: 'targetVersion required for rollback' };
      return { ok: true, result: await rollbackBlueprintRelease({ installedDir: INSTALLED_BLUEPRINTS_DIR(), id, target }) };
    } catch (error) {
      if (error instanceof BlueprintLifecycleError) return { ok: false, status: error.status, error: error.message };
      return { ok: false, status: 500, error: `${operation} failed`, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
  }

  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : undefined;
  let expectedRelease: { version?: string; contentHash?: string } | undefined;

  if (!githubUrl && input.listingId) {
    const resolved = await resolveBlueprintListing(String(input.listingId));
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    listingRef = listingRef ?? resolved.listingRef;
    expectedRelease = {
      ...(resolved.releaseVersion ? { version: resolved.releaseVersion } : {}),
      ...(resolved.releaseContentHash ? { contentHash: resolved.releaseContentHash } : {}),
    };
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };

  try {
    const result = await installBlueprintFromCupboardCore({
      githubUrl,
      listingRef,
      activationStack: activationLayers(input.activationStack),
      expectedRelease,
    }, makeInstallCoreDeps());

    // D-001's consent-gated plugin fetch: with `installPlugins: true`, install
    // each declared plugin resolvable from the Cupboard (not yet installed).
    // Best-effort per plugin — a failed install is reported, not swallowed.
    const pluginInstalls: Array<{ plugin: string; ok: boolean; error?: string }> = [];
    if (input.installPlugins === true && (result.depCheck?.installable.plugins.length ?? 0) > 0) {
      const { installPluginFromCupboardCore } = await import('./install-plugin-core');
      const base = resolveCupboardBaseUrl();
      for (const spec of result.depCheck!.installable.plugins) {
        const { name } = parseDepSpec(spec);
        try {
          const res = await fetch(`${base}/listings?kind=plugin&limit=100`, {
            headers: { 'User-Agent': 'papercusp-operator/1' },
            signal: AbortSignal.timeout(10_000),
          });
          const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
          const listing = (data.results ?? []).find((l) => l.listing_ref === name);
          const url = typeof listing?.github_url === 'string' ? listing.github_url : '';
          if (!url) throw new Error('no plugin listing with that ref');
          await installPluginFromCupboardCore({ githubUrl: url, listingRef: name }, buildInstallPluginDeps());
          pluginInstalls.push({ plugin: name, ok: true });
        } catch (e) {
          pluginInstalls.push({ plugin: name, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        }
      }
    }

    // Spawned-blueprint closure (blueprint-role-bundling P-007): a blueprint
    // declaring `dependencies.blueprints` pulls each declared work-blueprint
    // resolvable from the Cupboard and not already present. Best-effort per unit.
    const blueprintInstalls: Array<{ blueprint: string; ok: boolean; error?: string }> = [];
    const installableBps = result.depCheck?.installable.blueprints ?? [];
    if (installableBps.length > 0) {
      const base = resolveCupboardBaseUrl();
      for (const spec of installableBps) {
        const { name } = parseDepSpec(spec);
        try {
          const res = await fetch(`${base}/listings?kind=blueprint&limit=100`, {
            headers: { 'User-Agent': 'papercusp-operator/1' },
            signal: AbortSignal.timeout(10_000),
          });
          const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
          const listing = (data.results ?? []).find((l) => l.listing_ref === name);
          const url = typeof listing?.github_url === 'string' ? listing.github_url : '';
          if (!url) throw new Error('no blueprint listing with that ref');
          await installBlueprintFromCupboardCore({ githubUrl: url, listingRef: name }, makeInstallCoreDeps());
          blueprintInstalls.push({ blueprint: name, ok: true });
        } catch (e) {
          blueprintInstalls.push({ blueprint: name, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        }
      }
    }

    return { ok: true, result: { ...result, pluginInstalls, blueprintInstalls } };
  } catch (e) {
    if (e instanceof InstallBlueprintError) {
      return { ok: false, status: e.status, error: e.message };
    }
    return { ok: false, status: 500, error: 'install failed', detail: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  }
}
