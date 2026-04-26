/**
 * @papercusp/plugin-loader — discovers + loads plugins from disk.
 *
 * Plugins are directories that contain:
 *   - papercusp.json       manifest with name + version
 *   - index.{ts,js,mjs}    default-exports a Plugin
 *
 * The loader doesn't actually mount API routes or render dashboard tabs —
 * those happen in the harness API + UI hosts that consume this loader's
 * output. This module is just the file-system → typed-Plugin pipeline.
 *
 * Search paths (in order):
 *   1. <projectDir>/plugins/<name>/
 *   2. ~/.papercusp/harnesses/<harness-slug>/plugins/<name>/
 *   3. ~/.papercusp/global-plugins/<name>/
 */
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from '@papercusp/plugin-sdk';

export interface LoadedPlugin {
  plugin: Plugin;
  path: string;             // absolute dir of the plugin
  source: 'project' | 'harness' | 'global';
}

export interface LoaderOptions {
  projectDir?: string;       // <project>/plugins/<name>/
  harnessSlugs?: string[];   // ~/.papercusp/harnesses/<slug>/plugins/
  globalPluginsDir?: string; // override ~/.papercusp/global-plugins/
}

const PAPERCUSP_ROOT = join(homedir(), '.papercusp');

interface ManifestShape {
  name: string;
  version: string;
  description?: string;
  papercusp?: string;
}

async function readManifest(dir: string): Promise<ManifestShape | null> {
  try {
    const raw = await fs.readFile(join(dir, 'papercusp.json'), 'utf8');
    const parsed = JSON.parse(raw) as ManifestShape;
    if (!parsed?.name || !parsed?.version) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function locateEntry(dir: string): Promise<string | null> {
  // Prefer ts > js > mjs > index in dist/
  const candidates = [
    'index.ts',
    'index.js',
    'index.mjs',
    join('dist', 'index.js'),
    join('src', 'index.ts'),
  ];
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

async function importPluginEntry(entryPath: string): Promise<Plugin | null> {
  try {
    const url = pathToFileURL(entryPath).href;
    const mod = await import(/* @vite-ignore */ url);
    const candidate = mod?.default ?? mod;
    if (!candidate || typeof candidate !== 'object') return null;
    if (typeof (candidate as any).name !== 'string') return null;
    return candidate as Plugin;
  } catch {
    return null;
  }
}

function validate(plugin: Plugin, manifest: ManifestShape): string | null {
  if (plugin.name !== manifest.name) return `manifest.name "${manifest.name}" doesn't match plugin.name "${plugin.name}"`;
  if (plugin.version !== manifest.version) return `manifest.version "${manifest.version}" doesn't match plugin.version "${plugin.version}"`;
  return null;
}

/** Load a single plugin from a known directory. */
export async function loadPluginFromDir(dir: string, source: LoadedPlugin['source']): Promise<LoadedPlugin | { error: string; path: string }> {
  const path = resolve(dir);
  const manifest = await readManifest(path);
  if (!manifest) return { error: 'missing or invalid papercusp.json', path };
  const entry = await locateEntry(path);
  if (!entry) return { error: 'no entry point found (looked for index.ts, index.js, index.mjs, dist/index.js, src/index.ts)', path };
  const plugin = await importPluginEntry(entry);
  if (!plugin) return { error: `failed to import default export from ${entry}`, path };
  const validationError = validate(plugin, manifest);
  if (validationError) return { error: validationError, path };
  return { plugin, path, source };
}

async function listSubdirs(parent: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(parent, e.name));
  } catch {
    return [];
  }
}

/** Discover and load all plugins reachable via the configured search paths. */
export async function loadPlugins(opts: LoaderOptions = {}): Promise<{
  loaded: LoadedPlugin[];
  errors: Array<{ error: string; path: string }>;
}> {
  const loaded: LoadedPlugin[] = [];
  const errors: Array<{ error: string; path: string }> = [];

  // Collect candidate directories.
  const candidates: Array<{ dir: string; source: LoadedPlugin['source'] }> = [];

  if (opts.projectDir) {
    for (const d of await listSubdirs(join(opts.projectDir, 'plugins'))) {
      candidates.push({ dir: d, source: 'project' });
    }
  }
  for (const slug of opts.harnessSlugs ?? []) {
    for (const d of await listSubdirs(join(PAPERCUSP_ROOT, 'harnesses', slug, 'plugins'))) {
      candidates.push({ dir: d, source: 'harness' });
    }
  }
  const globalDir = opts.globalPluginsDir ?? join(PAPERCUSP_ROOT, 'global-plugins');
  for (const d of await listSubdirs(globalDir)) {
    candidates.push({ dir: d, source: 'global' });
  }

  // Load each. Dedupe by plugin.name (project > harness > global).
  const seen = new Set<string>();
  for (const c of candidates) {
    const result = await loadPluginFromDir(c.dir, c.source);
    if ('error' in result) {
      errors.push(result);
      continue;
    }
    if (seen.has(result.plugin.name)) continue;
    seen.add(result.plugin.name);
    loaded.push(result);
  }

  return { loaded, errors };
}

/**
 * Extract role definitions from all loaded plugins for registration with the
 * harness orchestrator. Throws if two plugins claim the same role name.
 */
export function collectRoles(loaded: LoadedPlugin[]): Record<string, { plugin: string; role: import('@papercusp/plugin-sdk').RoleDefinition }> {
  const roles: Record<string, { plugin: string; role: import('@papercusp/plugin-sdk').RoleDefinition }> = {};
  for (const lp of loaded) {
    const declared = lp.plugin.roles ?? {};
    for (const [name, role] of Object.entries(declared)) {
      if (roles[name]) {
        throw new Error(`role "${name}" claimed by both plugins ${roles[name].plugin} and ${lp.plugin.name}`);
      }
      roles[name] = { plugin: lp.plugin.name, role };
    }
  }
  return roles;
}
