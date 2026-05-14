/**
 * /api/plugins/* — surface plugin metadata loaded from disk.
 *
 * Manifest-only: this route reads `papercusp.json` from each plugin's
 * directory but does not dynamically import the plugin's index. Instantiation
 * + hook firing happens in node-side runners (run.sh + plugin produce
 * scripts), keeping the Next.js bundle simple.
 *
 * Search paths (in priority order):
 *   1. <project>/plugins/<name>/papercusp.json          (project-scoped)
 *   2. ~/.papercusp/harnesses/<harness-slug>/plugins/<name>/papercusp.json
 *   3. ~/.papercusp/global-plugins/<name>/papercusp.json
 *
 * Endpoints:
 *   GET /                              — all plugins, all sources, deduped
 *   GET /global                        — globally installed plugins
 *   GET /:slug/installed               — plugins reachable by the named project
 *   GET /:slug/contributions           — flat dashboard-tab + sidebar-item metadata
 */
import { Hono } from 'hono';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { papercuspRoot } from '@/lib/papercusp-root';

function HARNESSES_DIR() { return join(papercuspRoot(), 'harnesses'); }
function GLOBAL_PLUGINS_DIR() { return join(papercuspRoot(), 'global-plugins'); }
function REGISTRY_PATH() { return join(papercuspRoot(), 'registry.json'); }


/**
 * Phase 6a: contribution metadata declared in `papercusp.json`. Components
 * referenced by `componentId` are loaded at runtime by the UI host (Phase 6b).
 * Manifest carries only id + label + icon — no React refs.
 *
 * Pattern 1 (unified manifest): each tab picks its render mode by which
 * fields are set:
 *
 *   In-process React (build-time):
 *     {componentRoot, componentId}
 *
 *   Iframe (runtime, marketplace-friendly):
 *     {iframeUrl}                          ← static URL
 *     {iframeUrlConfigKey: 'codeServerUrl'} ← reads
 *       configSchema.properties[k].default, with per-harness override at
 *       ~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json[k].
 *
 * If both modes are present, the host prefers iframe (cheaper to validate at
 * runtime; no rebuild required to update).
 *
 * `replaces` lets a plugin tab take over a built-in tab id (docs/vscode/pi).
 * The dashboard hides the built-in version when a plugin replacement is
 * present — gives plugins a way to ship the same surface with custom UX.
 */
interface DashboardTabManifest {
  id: string;
  label: string;
  icon?: string;
  componentId?: string;        // resolved at UI-load time to a lazy import
  componentRoot?: string;      // optional per-tab override of plugin-level componentRoot
  iframeUrl?: string;          // direct URL — Pattern 1 iframe mode
  iframeUrlConfigKey?: string; // resolves through configSchema + per-harness config
  replaces?: string[];         // built-in tab ids this plugin tab supersedes
  /**
   * Append `&folder=<harness's project path>` to the resolved iframe URL.
   * Use this when the iframe target is a third-party service we don't
   * control (code-server, jupyter, n8n, …) that scopes by URL parameter
   * rather than by reading our `?harness=<slug>` query. Operator-served
   * iframe targets (fumadocs at /project-docs, pi at /pi) don't need
   * this — they read the slug server-side and look up the project path
   * themselves.
   */
  iframeAppendProjectFolder?: boolean;
}

interface SidebarItemManifest {
  id: string;
  label: string;
  href: string;
  icon?: string;
  badge?: { source: 'static' | 'fetch'; value?: string | number; url?: string };
}

interface UiContributionManifest {
  slug: string;                // mounted at /harness/<slug>
  label: string;
  icon?: string;
  componentId?: string;        // lazy-loaded at UI host
  componentRoot?: string;      // optional override of plugin-level componentRoot
}

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  papercusp?: string;
  capabilities?: string[];
  roles?: string[];            // role names declared (full RoleDefinition is in index.ts)
  dashboardTabs?: DashboardTabManifest[];
  sidebarItems?: SidebarItemManifest[];
  ui?: UiContributionManifest;
  routines?: Array<{ name: string; trigger: 'cron' | 'webhook' | 'api' }>;
  schema?: unknown;
  /** JSON-Schema describing config keys this plugin accepts. Used by
   *  `iframeUrlConfigKey` to read per-key `default` values. */
  configSchema?: { properties?: Record<string, { default?: unknown }> };
  [k: string]: unknown;
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

/**
 * Pattern 1 — resolve a tab's iframeUrl. Three sources, in priority order:
 *
 *   1. Per-harness override: `~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json`
 *      key matching `tab.iframeUrlConfigKey` — operator-controlled.
 *
 *   2. Manifest's configSchema default: same key, but read from
 *      `manifest.configSchema.properties[k].default`.
 *
 *   3. Direct: `tab.iframeUrl` (no config key indirection).
 *
 * Always appends `?harness=<slug>` so the iframe knows which install it's
 * scoped to. When `tab.iframeAppendProjectFolder === true`, also appends
 * `&folder=<projectPath>` for third-party iframe targets that don't
 * understand our `harness` query (e.g. code-server). Returns null if the
 * tab declares no iframe path at all.
 */
async function resolveIframeUrl(
  manifest: PluginManifest,
  tab: DashboardTabManifest,
  harnessConfig: Record<string, unknown> | null,
  harnessSlug: string,
): Promise<string | null> {
  let url: string | null = null;

  if (tab.iframeUrlConfigKey) {
    const k = tab.iframeUrlConfigKey;
    const fromConfig = harnessConfig?.[k];
    const fromDefault = manifest.configSchema?.properties?.[k]?.default;
    // Desktop bundle override: when the Tauri shell spawns the bundled
    // code-server on a free port it surfaces the URL via env. The plugin's
    // configSchema default (http://localhost:8082) only matches if the user
    // happens to have an external code-server running there, so the env
    // override beats the manifest default but still defers to per-harness
    // config so users can point at their own install.
    const fromEnv = k === 'codeServerUrl' ? process.env.PAPERCUSP_CODE_SERVER_URL : undefined;
    if (typeof fromConfig === 'string' && fromConfig.length > 0) url = fromConfig;
    else if (typeof fromEnv === 'string' && fromEnv.length > 0) url = fromEnv;
    else if (typeof fromDefault === 'string' && fromDefault.length > 0) url = fromDefault;
  }
  if (!url && typeof tab.iframeUrl === 'string' && tab.iframeUrl.length > 0) {
    url = tab.iframeUrl;
  }
  if (!url) return null;

  // Plugin manifests historically bake in `http://localhost:3055/<path>` for
  // operator-self-served iframes (fumadocs at /project-docs, pi-coding at /pi).
  // That breaks when the operator runs on a non-3055 port (prod build on :3070,
  // any custom port). Rewrite to a same-origin relative path so the iframe
  // resolves against whatever port the operator is actually serving on. We
  // only rewrite the operator's known dev URL; external services like
  // code-server (e.g. localhost:8082) are left alone.
  url = url.replace(/^https?:\/\/localhost:3055(\/|$)/, '$1');

  const sep = url.includes('?') ? '&' : '?';
  url = `${url}${sep}harness=${encodeURIComponent(harnessSlug)}`;

  if (tab.iframeAppendProjectFolder) {
    const projectPath = await resolveProjectPath(harnessSlug);
    if (projectPath) {
      url = `${url}&folder=${encodeURIComponent(projectPath)}`;
    }
    // Unknown slug → no folder hint; iframe falls back to whatever the
    // third-party service has cached. Better than a 500.
  }

  return url;
}

export async function listPluginsIn(parent: string, source: 'project' | 'harness' | 'global'): Promise<Array<PluginManifest & { source: string; path: string }>> {
  const out: Array<PluginManifest & { source: string; path: string }> = [];
  if (!existsSync(parent)) return out;
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    // Accept directories AND symlinks (dev-mode pattern: symlinking a
    // plugin's repo dir into ~/.papercusp/global-plugins/).
    let isDirOrLinkToDir = e.isDirectory();
    if (!isDirOrLinkToDir && e.isSymbolicLink()) {
      const target = await fs.stat(join(parent, e.name)).catch(() => null);
      isDirOrLinkToDir = target?.isDirectory() ?? false;
    }
    if (!isDirOrLinkToDir) continue;
    const dir = join(parent, e.name);
    const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
    if (m?.name && m?.version) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        out.push({ ...m, source, path: dir });
      }
      continue;
    }
    // No manifest at this level. If the dirname looks like an npm scope
    // (e.g. `@papercupai`), recurse one level (HMR bust marker) — `papercusp install <slug>`
    // extracts scoped packages into `<scope>/<name>/`. Matches the runtime
    // loader's behaviour (loader.test.ts > recurses into @scope/ dirs).
    if (!e.name.startsWith('@')) continue;
    const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const sub of inner) {
      if (sub.name.startsWith('.')) continue;
      let subIsDir = sub.isDirectory();
      if (!subIsDir && sub.isSymbolicLink()) {
        const t = await fs.stat(join(dir, sub.name)).catch(() => null);
        subIsDir = t?.isDirectory() ?? false;
      }
      if (!subIsDir) continue;
      const subDir = join(dir, sub.name);
      const subM = await readJson<PluginManifest>(join(subDir, 'papercusp.json'));
      if (!subM?.name || !subM?.version) continue;
      if (seen.has(subM.name)) continue;
      seen.add(subM.name);
      out.push({ ...subM, source, path: subDir });
    }
  }
  return out;
}

interface RegistryShape {
  projects: Array<{ slug: string; path: string }>;
}

async function resolveProjectPath(slug: string): Promise<string | null> {
  const { loadHarnessRegistry } = await import('@/lib/harness-registry');
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

export const plugins = new Hono();

plugins.get('/runtime/status', async (c) => {
  const { pluginHostStatus, _resetPluginHostForTests } = await import('../../../lib/plugin-host-runtime');
  if (c.req.query('reset') === '1') {
    _resetPluginHostForTests();
    const { _resetPluginApiRoutesForTests, mountPluginApiRoutes } = await import('../../../lib/plugin-api-mount');
    _resetPluginApiRoutesForTests();
    // Rebuild the in-memory apiRoutes registry so freshly-symlinked
    // plugins become reachable without a server restart. The dispatcher
    // route was registered once at boot and reads from this registry.
    await mountPluginApiRoutes(plugins);
  }
  try {
    const s = await pluginHostStatus();
    return c.json(s);
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500);
  }
});

plugins.post('/runtime/invoke-action', async (c) => {
  // Diagnostic — invoke a plugin action via the in-process registry
  // (different code path from the existing `/api/plugins/invoke` which
  // shells out to the `papercusp` CLI). Useful for verifying that
  // Phase 6b wiring is functional from the host's perspective.
  //
  // Body: { plugin: string; action: string; slug: string; params?: object }
  const body = await c.req.json().catch(() => ({} as any));
  const plugin = String(body?.plugin ?? '');
  const action = String(body?.action ?? '');
  const slug = String(body?.slug ?? '');
  if (!plugin || !action || !slug) {
    return c.json({ error: 'plugin, action, slug are all required' }, 400);
  }
  const { loadHarnessRegistry } = await import('@/lib/harness-registry');
  const project = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug) ?? null;
  const projectDir = project?.path ?? '/tmp';
  const stateDir = project ? `${project.path}/.harness` : '/tmp';
  const { invokePluginAction } = await import('../../../lib/plugin-host-runtime');
  try {
    const r = await invokePluginAction({
      pluginName: plugin,
      actionName: action,
      installSlug: slug,
      projectDir,
      stateDir,
      params: body?.params,
      triggerSource: 'api',
      triggerId: `diag-${Date.now()}`,
    });
    return c.json(r);
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});

plugins.post('/runtime/fire-event', async (c) => {
  // Diagnostic — fire a free-form event OR a typed lifecycle hook through
  // the host runtime. Useful for smoke-testing handler wiring without
  // touching the substrate's mission lifecycle.
  //
  // Body: { event: string; lifecycle?: keyof PluginHooks; slug?: string; args?: unknown[] }
  const body = await c.req.json().catch(() => ({} as any));
  const event = typeof body?.event === 'string' ? body.event : '';
  const lifecycle = typeof body?.lifecycle === 'string' ? body.lifecycle : '';
  const { firePluginEvent, firePluginLifecycle } = await import('../../../lib/plugin-host-runtime');
  try {
    if (lifecycle) {
      const slug = String(body?.slug ?? 'diag');
      const harnessSlugs = (() => {
        try { return require('node:fs').readdirSync(require('node:os').homedir() + '/.papercusp/harnesses'); }
        catch { return []; }
      })();
      const { loadHarnessRegistry } = await import('@/lib/harness-registry');
      const project = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug) ?? null;
      const ctxArgs = {
        installSlug: slug,
        projectDir: project?.path ?? '/tmp',
        stateDir: project ? `${project.path}/.harness` : '/tmp',
      };
      const args = Array.isArray(body?.args) ? body.args : [];
      await (firePluginLifecycle as any)(lifecycle, ctxArgs, ...args);
      return c.json({ ok: true, fired: lifecycle, slug });
    }
    if (!event) return c.json({ error: 'event (string) or lifecycle (string) required' }, 400);
    await firePluginEvent(event, body?.payload ?? {});
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500);
  }
});

plugins.get('/global', async (c) => {
  const items = await listPluginsIn(GLOBAL_PLUGINS_DIR(), 'global');
  return c.json({ plugins: items });
});

plugins.get('/:slug/installed', async (c) => {
  const slug = c.req.param('slug');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return c.json({ error: 'invalid slug' }, 400);
  }
  const projectPath = await resolveProjectPath(slug);
  const sources: Array<{ name: string; dir: string; source: 'project' | 'harness' | 'global' }> = [];
  if (projectPath) {
    sources.push({ name: slug, dir: join(projectPath, 'plugins'), source: 'project' });
  }

  // Walk every installed harness — each may carry its own bundled plugins
  // in <harness>/plugins/. (When a project was created via `papercusp init
  // --from <X>`, those plugins were copied; but if a project is registered
  // independently, we still want to surface what plugins exist for the
  // harness templates the user has installed.)
  if (existsSync(HARNESSES_DIR())) {
    const harnessDirs = await fs.readdir(HARNESSES_DIR(), { withFileTypes: true }).catch(() => []);
    for (const h of harnessDirs) {
      if (!h.isDirectory()) continue;
      sources.push({ name: h.name, dir: join(HARNESSES_DIR(), h.name, 'plugins'), source: 'harness' });
    }
  }
  sources.push({ name: 'global', dir: GLOBAL_PLUGINS_DIR(), source: 'global' });

  const seen = new Set<string>();
  const items: Array<PluginManifest & { source: string; path: string }> = [];
  for (const s of sources) {
    for (const p of await listPluginsIn(s.dir, s.source)) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      items.push(p);
    }
  }

  return c.json({
    project: { slug, path: projectPath },
    plugins: items,
  });
});

/**
 * Phase 6a: list every plugin reachable from any source, deduped.
 * Useful for the marketplace + admin "what's installed" views.
 */
plugins.get('/', async (c) => {
  const sources: Array<{ dir: string; source: 'project' | 'harness' | 'global' }> = [];
  if (existsSync(HARNESSES_DIR())) {
    const harnessDirs = await fs.readdir(HARNESSES_DIR(), { withFileTypes: true }).catch(() => []);
    for (const h of harnessDirs) {
      if (!h.isDirectory()) continue;
      sources.push({ dir: join(HARNESSES_DIR(), h.name, 'plugins'), source: 'harness' });
    }
  }
  sources.push({ dir: GLOBAL_PLUGINS_DIR(), source: 'global' });

  const seen = new Set<string>();
  const items: Array<PluginManifest & { source: string; path: string }> = [];
  for (const s of sources) {
    for (const p of await listPluginsIn(s.dir, s.source)) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      items.push(p);
    }
  }
  return c.json({ plugins: items });
});

/**
 * Phase 6a: flat list of all UI contributions (dashboard tabs, sidebar items,
 * ui routes) declared by plugins reachable from this project.
 *
 * The Next.js client uses this to render plugin-contributed surfaces.
 * componentIds are returned as-is; Phase 6b adds dynamic-import resolution.
 */
plugins.get('/:slug/contributions', async (c) => {
  const slug = c.req.param('slug');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return c.json({ error: 'invalid slug' }, 400);
  }
  const projectPath = await resolveProjectPath(slug);
  const sources: Array<{ name: string; dir: string; source: 'project' | 'harness' | 'global' }> = [];
  if (projectPath) {
    sources.push({ name: slug, dir: join(projectPath, 'plugins'), source: 'project' });
  }
  if (existsSync(HARNESSES_DIR())) {
    const harnessDirs = await fs.readdir(HARNESSES_DIR(), { withFileTypes: true }).catch(() => []);
    for (const h of harnessDirs) {
      if (!h.isDirectory()) continue;
      sources.push({ name: h.name, dir: join(HARNESSES_DIR(), h.name, 'plugins'), source: 'harness' });
    }
  }
  sources.push({ name: 'global', dir: GLOBAL_PLUGINS_DIR(), source: 'global' });

  // Per-harness opt-in (Phase D): only surface plugins that are explicitly
  // enabled in <harness>/enabled-plugins.json. Plugins bundled inside the
  // project dir or inside the harness's own /plugins/ tree (source=project
  // or source=harness) keep auto-attaching — they are first-class to that
  // install. Only `source=global` is gated.
  type EnabledFile = { enabled: Record<string, { version: string }> };
  const enabledFile = await readJson<EnabledFile>(
    join(HARNESSES_DIR(), slug, 'enabled-plugins.json'),
  );
  const enabledSet = new Set<string>(enabledFile ? Object.keys(enabledFile.enabled) : []);

  const seen = new Set<string>();
  type Tab = DashboardTabManifest & { pluginName: string };
  type Item = SidebarItemManifest & { pluginName: string };
  type Route = UiContributionManifest & { pluginName: string };
  const dashboardTabs: Tab[] = [];
  const sidebarItems: Item[] = [];
  const routes: Route[] = [];
  // Dockview-migration v4 §8.1: plugin-contributed dock panels.
  type PanelContrib = {
    pluginName: string;
    id: string;
    fullType: string;
    title: string;
    icon?: string;
    type: 'react' | 'iframe';
    componentRoot?: string;
    componentId?: string;
    src?: string;
    defaultGroup?: string;
    defaultFloating?: { width?: number; height?: number };
    keepAlive?: boolean;
  };
  const panelsContrib: PanelContrib[] = [];

  for (const s of sources) {
    for (const p of await listPluginsIn(s.dir, s.source)) {
      if (seen.has(p.name)) continue;
      // Phase D: gate global plugins behind enabled-plugins.json. The CLI
      // keys enabled-plugins.json by the on-disk directory name (which may
      // be a short slug like `fumadocs` even when the manifest's `name`
      // is the scoped form `@papercupai/fumadocs`). Match either form.
      const dirBasename = basename(p.path);
      if (s.source === 'global' && !(enabledSet.has(p.name) || enabledSet.has(dirBasename))) continue;
      seen.add(p.name);
      // Plugin-level componentRoot cascades to any contribution that
      // doesn't specify its own (Phase 6b runtime needs componentRoot
      // per contribution to do the dynamic import).
      const pluginRoot = (p as PluginManifest & { componentRoot?: string }).componentRoot;
      // Per-harness plugin config (operator overrides for iframeUrlConfigKey).
      const harnessConfig = await readJson<Record<string, unknown>>(
        join(HARNESSES_DIR(), slug, 'plugin-configs', `${p.name}.json`),
      );
      for (const tab of p.dashboardTabs ?? []) {
        const resolvedIframeUrl = await resolveIframeUrl(p, tab, harnessConfig, slug);
        dashboardTabs.push({
          componentRoot: tab.componentRoot ?? pluginRoot,
          ...tab,
          iframeUrl: resolvedIframeUrl ?? tab.iframeUrl,
          pluginName: p.name,
        });
        // Dockview-migration v4 §8.1 + §8.2: synthesize a panels[] entry
        // from each dashboardTabs[] entry so the new dock UI can register
        // plugin panels without forcing manifest changes. The original
        // tab keeps working in the existing dashboard tab strip; the
        // synthesized entry lets the new dock model surface the same
        // plugin via panelRegistry.register('plugin:<name>:<id>', …).
        panelsContrib.push({
          pluginName: p.name,
          id: tab.id,
          fullType: `plugin:${p.name}:${tab.id}`,
          title: tab.label,
          icon: tab.icon,
          type: resolvedIframeUrl ?? tab.iframeUrl ? 'iframe' : 'react',
          componentRoot: tab.componentRoot ?? pluginRoot,
          componentId: tab.componentId,
          src: resolvedIframeUrl ?? tab.iframeUrl,
        });
      }
      // Native `panels[]` declaration (manifest opted into the new field).
      type PanelDecl = {
        id: string;
        title: string;
        icon?: string;
        type?: 'react' | 'iframe';
        componentRoot?: string;
        componentId?: string;
        src?: string;
        iframeUrl?: string;
        iframeUrlConfigKey?: string;
        defaultGroup?: string;
        defaultFloating?: { width?: number; height?: number };
        keepAlive?: boolean;
      };
      const declared = ((p as PluginManifest & { panels?: PanelDecl[] }).panels ?? []);
      for (const panel of declared) {
        let resolvedSrc = panel.src ?? panel.iframeUrl;
        if (!resolvedSrc && panel.iframeUrlConfigKey) {
          // Re-use resolveIframeUrl: synthesize a tab-shaped object.
          const synthTab: DashboardTabManifest = {
            id: panel.id,
            label: panel.title,
            iframeUrlConfigKey: panel.iframeUrlConfigKey,
          };
          resolvedSrc = (await resolveIframeUrl(p, synthTab, harnessConfig, slug)) ?? undefined;
        }
        panelsContrib.push({
          pluginName: p.name,
          id: panel.id,
          fullType: `plugin:${p.name}:${panel.id}`,
          title: panel.title,
          icon: panel.icon,
          type: panel.type ?? (resolvedSrc ? 'iframe' : 'react'),
          componentRoot: panel.componentRoot ?? pluginRoot,
          componentId: panel.componentId,
          src: resolvedSrc,
          defaultGroup: panel.defaultGroup,
          defaultFloating: panel.defaultFloating,
          keepAlive: panel.keepAlive,
        });
      }
      for (const item of p.sidebarItems ?? []) {
        sidebarItems.push({ ...item, pluginName: p.name });
      }
      if (p.ui) {
        routes.push({
          componentRoot: p.ui.componentRoot ?? pluginRoot,
          ...p.ui,
          pluginName: p.name,
        });
      }
    }
  }

  return c.json({
    project: { slug, path: projectPath },
    dashboardTabs,
    sidebarItems,
    routes,
    panels: panelsContrib,
  });
});
