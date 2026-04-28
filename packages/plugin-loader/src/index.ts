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
  // Prefer compiled .js over source .ts. Reason: bundled runtimes (Next.js
  // Turbopack, webpack standalone) can dynamic-import .js but not .ts at
  // runtime. When both exist, .js is the runtime-canonical artifact and
  // .ts is just for editor tooling.
  const candidates = [
    'index.js',
    'index.mjs',
    join('dist', 'index.js'),
    'index.ts',
    join('src', 'index.ts'),
  ];
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

// Bundler-opaque dynamic import. Webpack/Turbopack refuse to compile a bare
// `import(varURL)` (or even `new Function('return import(...)')()`) because
// they statically scan all `import(...)` calls. We use Node's createRequire
// which delegates to Node's native module resolver — bundlers don't try to
// reach inside `module.createRequire(...)` to follow what gets required.
//
// Caveat: createRequire only handles CommonJS. ESM plugins must compile to
// CJS (or ship .cjs alongside .mjs). For the v1 plugin loader, plugins are
// expected to ship CJS-compatible artifacts.
import { createRequire } from 'node:module';

async function importPluginEntry(entryPath: string): Promise<Plugin | { error: string } | null> {
  try {
    const req = createRequire(entryPath);
    const mod = req(entryPath);
    const candidate = mod?.default ?? mod;
    if (!candidate || typeof candidate !== 'object') return null;
    if (typeof (candidate as any).name !== 'string') return null;
    return candidate as Plugin;
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

function validate(plugin: Plugin, manifest: ManifestShape): string | null {
  if (plugin.name !== manifest.name) return `manifest.name "${manifest.name}" doesn't match plugin.name "${plugin.name}"`;
  if (plugin.version !== manifest.version) return `manifest.version "${manifest.version}" doesn't match plugin.version "${plugin.version}"`;
  if (!Array.isArray(plugin.capabilities)) {
    return `plugin "${plugin.name}" must declare \`capabilities: Capability[]\` (can be empty array, but the field is required)`;
  }
  // Validate that for each declared role, the plugin holds 'roles:register:<name>'.
  for (const roleName of Object.keys(plugin.roles ?? {})) {
    const requiredCap = `roles:register:${roleName}`;
    if (!plugin.capabilities.includes(requiredCap as any)) {
      return `plugin "${plugin.name}" registers role "${roleName}" but lacks capability "${requiredCap}"`;
    }
  }
  // Validate UI requires the right cap.
  if (plugin.ui && !plugin.capabilities.includes('ui:harness-route' as any)) {
    return `plugin "${plugin.name}" declares ui contribution but lacks capability "ui:harness-route"`;
  }
  if ((plugin.dashboardTabs?.length ?? 0) > 0 && !plugin.capabilities.includes('ui:dashboard-tab' as any)) {
    return `plugin "${plugin.name}" declares dashboardTabs but lacks capability "ui:dashboard-tab"`;
  }
  if ((plugin.sidebarItems?.length ?? 0) > 0 && !plugin.capabilities.includes('ui:sidebar-item' as any)) {
    return `plugin "${plugin.name}" declares sidebarItems but lacks capability "ui:sidebar-item"`;
  }
  return null;
}

/** Load a single plugin from a known directory. */
export async function loadPluginFromDir(dir: string, source: LoadedPlugin['source']): Promise<LoadedPlugin | { error: string; path: string }> {
  const path = resolve(dir);
  const manifest = await readManifest(path);
  if (!manifest) return { error: 'missing or invalid papercusp.json', path };
  const entry = await locateEntry(path);
  if (!entry) return { error: 'no entry point found (looked for index.ts, index.js, index.mjs, dist/index.js, src/index.ts)', path };
  const importResult = await importPluginEntry(entry);
  if (!importResult) return { error: `import returned null/non-object from ${entry}`, path };
  if ('error' in importResult) return { error: `import threw at ${entry}: ${importResult.error}`, path };
  const plugin = importResult;
  const validationError = validate(plugin, manifest);
  if (validationError) return { error: validationError, path };
  return { plugin, path, source };
}

async function listSubdirs(parent: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        // Follow symlinks (dev-mode pattern: symlinking a plugin's repo
        // dir into ~/.papercusp/global-plugins/<name>).
        try {
          const st = await fs.stat(join(parent, e.name));
          isDir = st.isDirectory();
        } catch { /* dangling symlink — skip */ }
      }
      if (isDir) out.push(join(parent, e.name));
    }
    return out;
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

/**
 * Extract routine definitions from all loaded plugins for registration with
 * the substrate's routine ticker. Names are namespaced with the plugin name
 * so two plugins can ship a routine of the same name without collision.
 */
export function collectRoutines(loaded: LoadedPlugin[]): Array<{
  pluginName: string;
  routineName: string;       // namespaced: "<plugin>.<routine>"
  routine: import('@papercusp/plugin-sdk').RoutineDefinition;
}> {
  const out: Array<{ pluginName: string; routineName: string; routine: import('@papercusp/plugin-sdk').RoutineDefinition }> = [];
  for (const lp of loaded) {
    for (const r of lp.plugin.routines ?? []) {
      out.push({
        pluginName: lp.plugin.name,
        routineName: `${lp.plugin.name}.${r.name}`,
        routine: r,
      });
    }
  }
  return out;
}

/**
 * Extract UI contributions from all loaded plugins. The host can iterate
 * these to mount routes, sidebar items, and dashboard tabs.
 */
export function collectUiContributions(loaded: LoadedPlugin[]): {
  routes: Array<{ pluginName: string; ui: import('@papercusp/plugin-sdk').UiContribution }>;
  dashboardTabs: Array<{ pluginName: string; tab: import('@papercusp/plugin-sdk').DashboardTab }>;
  sidebarItems: Array<{ pluginName: string; item: import('@papercusp/plugin-sdk').SidebarItem }>;
} {
  const routes: Array<{ pluginName: string; ui: import('@papercusp/plugin-sdk').UiContribution }> = [];
  const dashboardTabs: Array<{ pluginName: string; tab: import('@papercusp/plugin-sdk').DashboardTab }> = [];
  const sidebarItems: Array<{ pluginName: string; item: import('@papercusp/plugin-sdk').SidebarItem }> = [];

  for (const lp of loaded) {
    if (lp.plugin.ui) routes.push({ pluginName: lp.plugin.name, ui: lp.plugin.ui });
    for (const tab of lp.plugin.dashboardTabs ?? []) {
      dashboardTabs.push({ pluginName: lp.plugin.name, tab });
    }
    for (const item of lp.plugin.sidebarItems ?? []) {
      sidebarItems.push({ pluginName: lp.plugin.name, item });
    }
  }

  return { routes, dashboardTabs, sidebarItems };
}

// ─── Re-exports ──────────────────────────────────────────────────────
export {
  hasCapability,
  requireCapability,
  wrapServiceWithCaps,
  makeFetchProxy,
  makeSecretsProxy,
  MissingCapabilityError,
  UnknownMethodError,
  type CapabilityCheckContext,
} from './capabilities';

export {
  HookBus,
  createPluginHookBus,
} from './hookbus';

export {
  createPapercuspApi,
  TasksServiceDef,
  GoalsServiceDef,
  PendingEventsServiceDef,
  RoutinesServiceDef,
  CommentsServiceDef,
  SecretsServiceDef,
  PluginStorageDef,
  PluginDbDef,
  type RealServices,
  type CreatePapercuspApiInput,
} from './api-factory';
