/**
 * Install a plugin FROM the Cupboard (revive-cupboard-distribution-2026-06-04
 * D-003 / P2). The Cupboard is a GitHub-repo-backed listing registry — a
 * `kind=plugin` listing points at the plugin's GitHub repo (+ a `listing_ref`
 * discriminator when the repo hosts several). Installing it = git-clone the
 * repo, locate the plugin's `papercusp.json`, place it under global-plugins, and
 * wire the existing capability-gate + install-consent path (D-009): the
 * manifest's declared capabilities are recorded as grants for the target harness
 * when the caller consents.
 *
 * This REPLACES the dead `:3057`/CLI tarball install (D-004) with a git clone —
 * the model the Cupboard already uses for every other listing kind.
 *
 * The core is dependency-injected (clone / global-plugins dir / grant /
 * host-invalidate) so it's unit-testable without real git, network, PG, or the
 * route registry. The route (`install-plugin.ts`) wires the real impls.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface InstallPluginCoreInput {
  /** The plugin repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo plugin discriminator — a subdir to look in first, and the slug to match. */
  listingRef?: string;
  /** Optional target harness: when set with `acceptCapabilities`, the manifest's
   *  declared capabilities are granted for this harness (install-consent). */
  harness?: string;
  /** Record the manifest's declared capabilities as grants for `harness`. */
  acceptCapabilities?: boolean;
}

export interface InstalledPluginManifest {
  name: string;
  version: string;
  description?: string;
  capabilities?: string[];
  [k: string]: unknown;
}

export interface InstallPluginCoreResult {
  ok: true;
  name: string;
  version: string;
  capabilities: string[];
  source: string;
  installedTo: string;
  /** Capabilities granted for `harness` (only when harness + acceptCapabilities). */
  granted: string[];
}

export interface InstallPluginCoreDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** Absolute path of the global-plugins dir (install target parent). */
  globalPluginsDir: () => string;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
  /** Persist capability grants for a (plugin, version, harness) — install-consent. */
  grant: (args: {
    pluginName: string;
    pluginVersion: string;
    harnessSlug: string;
    capabilities: string[];
  }) => Promise<void>;
  /** Drop the in-memory plugin-host + api-route caches so the new plugin goes live. */
  invalidateHost: () => void | Promise<void>;
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;

export class InstallPluginError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'InstallPluginError';
  }
}

// A plugin name becomes a directory under global-plugins, so it must be a safe
// SINGLE-SEGMENT slug — never a path. It is UNTRUSTED (from the cloned repo's
// papercusp.json), so reject anything with a separator, a leading dot, or `..`.
const SAFE_PLUGIN_NAME_RE = /^@?[a-z0-9][a-z0-9._-]{0,127}$/i;

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallPluginError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/** A within-repo subdir ref must be relative, charset-safe, and contain no `..`/empty segment. */
function isSafeListingRef(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

async function readManifest(dir: string): Promise<InstalledPluginManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(join(dir, 'papercusp.json'), 'utf8')) as InstalledPluginManifest;
    return m?.name && m?.version ? m : null;
  } catch {
    return null;
  }
}

/**
 * Find the plugin within a freshly-cloned repo. Prefers the `listingRef` subdir
 * (a repo hosting several plugins), else the repo root (single-plugin repo).
 */
async function locatePlugin(
  cloneDir: string,
  listingRef: string | undefined,
): Promise<{ dir: string; manifest: InstalledPluginManifest }> {
  const candidates: string[] = [];
  if (listingRef && isSafeListingRef(listingRef)) {
    const sub = join(cloneDir, listingRef);
    assertInside(cloneDir, sub, `listing_ref "${listingRef}"`);
    candidates.push(sub);
  }
  candidates.push(cloneDir);
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const manifest = await readManifest(dir);
    if (manifest) return { dir, manifest };
  }
  throw new InstallPluginError('no papercusp.json found in the plugin repo (checked listing_ref subdir + root)', 422);
}

/** Recursively copy a plugin dir into `target`, excluding the repo's .git. */
async function copyPluginDir(src: string, target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(src, target, {
    recursive: true,
    filter: (s) => !s.split(/[/\\]/).includes('.git'),
  });
}

export async function installPluginFromCupboardCore(
  input: InstallPluginCoreInput,
  deps: InstallPluginCoreDeps,
): Promise<InstallPluginCoreResult> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallPluginError(`invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`, 400);
  }

  const cloneDir = join(deps.tmpDir(), `cupboard-plugin-${Date.now()}-${Math.floor(performance.now())}`);
  try {
    await deps.cloneRepo(url, cloneDir);
    const { dir: pluginDir, manifest } = await locatePlugin(cloneDir, input.listingRef);

    // manifest.name is UNTRUSTED (from the cloned repo) and becomes a directory we
    // `rm -rf` + `cp` into — so it must be a safe single-segment slug, never a path.
    // Otherwise a malicious manifest (`"name": "../../.ssh"`) would delete/overwrite
    // files outside global-plugins (path traversal → arbitrary file deletion).
    if (typeof manifest.name !== 'string' || !SAFE_PLUGIN_NAME_RE.test(manifest.name)) {
      throw new InstallPluginError(
        `unsafe plugin name ${JSON.stringify(manifest.name)} — must be a single-segment slug`,
        400,
      );
    }
    const target = join(deps.globalPluginsDir(), manifest.name);
    assertInside(deps.globalPluginsDir(), target, `plugin name "${manifest.name}"`);
    await fs.mkdir(deps.globalPluginsDir(), { recursive: true });
    await copyPluginDir(pluginDir, target);

    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];

    // Install-consent (D-009): when a target harness is given and the caller
    // accepted, record the manifest's declared caps as grants for that harness.
    // The runtime then enforces `manifest ∩ granted` (fork-install-consent).
    let granted: string[] = [];
    if (input.harness && input.acceptCapabilities && capabilities.length > 0) {
      await deps.grant({
        pluginName: manifest.name,
        pluginVersion: manifest.version,
        harnessSlug: input.harness,
        capabilities,
      });
      granted = capabilities;
    }

    await deps.invalidateHost();

    return {
      ok: true,
      name: manifest.name,
      version: manifest.version,
      capabilities,
      source: url,
      installedTo: target,
      granted,
    };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
