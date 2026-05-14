import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { papercuspRoot } from '@/lib/papercusp-root';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/plugins/:slug/contributions — manifest-only contribution
 * metadata (dashboardTabs, sidebarItems, ui routes) for plugins enabled
 * in the named harness. Mirrors the Hono /plugins/:slug/contributions
 * endpoint but bypasses the catch-all (which adds 6-11s of compile +
 * mount-walk latency on top of the actual filesystem walk). Used by
 * HarnessDashboard's tab-strip render.
 */
// Resolved per-call so workspace switches take effect without a restart.
function HARNESSES_DIR() { return join(papercuspRoot(), 'harnesses'); }
function GLOBAL_PLUGINS_DIR() { return join(papercuspRoot(), 'global-plugins'); }

interface DashboardTabManifest {
  id: string; label: string; icon?: string;
  componentId?: string; componentRoot?: string;
  iframeUrl?: string; iframeUrlConfigKey?: string;
  replaces?: string[];
  /** See app/api/_hono/plugins.ts for the canonical doc. */
  iframeAppendProjectFolder?: boolean;
  /**
   * 'iframe' (default) → render inside a sandboxed <iframe>.
   * 'inline-dock' → host renders the plugin's component directly without
   *   an intermediate iframe, by name. Requires the host (HarnessDashboard)
   *   to know how to render this specific dock; today only @papercupai/pi-coding
   *   uses inline-dock for its 'pi' tab because the iframe path deadlocks in
   *   Next dev. See InlinePiDock for the host-side hookup.
   */
  embedMode?: 'iframe' | 'inline-dock';
}
interface SidebarItemManifest {
  id: string; label: string; href: string; icon?: string;
  badge?: { source: 'static' | 'fetch'; value?: string | number; url?: string };
}
interface UiContributionManifest {
  slug: string; label: string; icon?: string;
  componentId?: string; componentRoot?: string;
}
interface PluginManifest {
  name: string; version: string;
  description?: string; author?: string;
  componentRoot?: string;
  dashboardTabs?: DashboardTabManifest[];
  sidebarItems?: SidebarItemManifest[];
  ui?: UiContributionManifest;
  configSchema?: { properties?: Record<string, { default?: unknown }> };
  [k: string]: unknown;
}

async function readJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    // File not present — that's a normal state, e.g. a harness with no
    // plugins enabled. Caller's "no plugins" branch handles it.
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    // Tolerate the most common hand-edit mistake: trailing comma before
    // a closing `}` or `]`. A malformed enabled-plugins.json otherwise
    // silently nukes every plugin tab on the dashboard, which is a much
    // worse failure mode than this one-line recovery.
    const stripped = raw.replace(/,(\s*[\]}])/g, '$1');
    try {
      return JSON.parse(stripped) as T;
    } catch {
      console.warn(
        `[plugins/contributions] failed to parse ${path} — file is malformed JSON, treating as empty. Original error:`,
        (e as Error).message,
      );
      return null;
    }
  }
}

async function listPluginsIn(parent: string, source: 'project' | 'harness' | 'global'): Promise<Array<PluginManifest & { source: string; path: string }>> {
  const out: Array<PluginManifest & { source: string; path: string }> = [];
  if (!existsSync(parent)) return out;
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDirOrLinkToDir = e.isDirectory();
    if (!isDirOrLinkToDir && e.isSymbolicLink()) {
      const stat = await fs.stat(join(parent, e.name)).catch(() => null);
      isDirOrLinkToDir = stat?.isDirectory() ?? false;
    }
    if (!isDirOrLinkToDir) continue;
    const dir = join(parent, e.name);
    const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
    if (!m?.name || !m?.version) continue;
    out.push({ ...m, source, path: dir });
  }
  return out;
}

async function resolveProjectPath(slug: string): Promise<string | null> {
  const { loadHarnessRegistry } = await import('@/lib/harness-registry');
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

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
    // Desktop bundle override — see app/api/_hono/plugins.ts for rationale.
    const fromEnv = k === 'codeServerUrl' ? process.env.PAPERCUSP_CODE_SERVER_URL : undefined;
    if (typeof fromConfig === 'string' && fromConfig.length > 0) url = fromConfig;
    else if (typeof fromEnv === 'string' && fromEnv.length > 0) url = fromEnv;
    else if (typeof fromDefault === 'string' && fromDefault.length > 0) url = fromDefault;
  }
  if (!url && typeof tab.iframeUrl === 'string' && tab.iframeUrl.length > 0) {
    url = tab.iframeUrl;
  }
  if (!url) return null;

  // Same rewrite as in app/api/_hono/plugins.ts: plugin manifests bake in
  // 'http://localhost:3055/<path>' for operator-self-served iframes (e.g.
  // fumadocs at /project-docs). Strip that prefix so the iframe resolves
  // against whatever origin the operator is actually serving on (works for
  // prod :3070, custom ports, the desktop sidecar, etc.).
  url = url.replace(/^https?:\/\/localhost:3055(\/|$)/, '$1');

  const sep = url.includes('?') ? '&' : '?';
  url = `${url}${sep}harness=${encodeURIComponent(harnessSlug)}`;

  if (tab.iframeAppendProjectFolder) {
    const projectPath = await resolveProjectPath(harnessSlug);
    if (projectPath) {
      url = `${url}&folder=${encodeURIComponent(projectPath)}`;
    }
  }

  return url;
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ error: 'invalid slug' }, { status: 400 });
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

  // Per-harness opt-in for global plugins.
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
  // Dockview-migration v4 §8.1: plugin-contributed dock panels. Each
  // dashboardTabs[] entry is also surfaced as a panels[] entry so the
  // new dock can register plugin panels via panelRegistry without
  // forcing manifest changes. Plugins using the new top-level panels[]
  // field land here too.
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
      const dirBasename = basename(p.path);
      if (s.source === 'global' && !(enabledSet.has(p.name) || enabledSet.has(dirBasename))) continue;
      seen.add(p.name);
      const pluginRoot = (p as PluginManifest & { componentRoot?: string }).componentRoot;
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
        // §8.2: pluginTab.replaces is meaningful in the classic dashboard
        // tab strip (a plugin replacing a built-in tab id). In the dock
        // model there are no top-level tabs to replace — the plugin's
        // panel registers as plugin:<name>:<id> regardless. Warn and
        // ignore.
        if (tab.replaces && Array.isArray(tab.replaces) && tab.replaces.length > 0) {
          console.warn(
            `[dock] plugin ${p.name} tab "${tab.id}" declares replaces=${JSON.stringify(tab.replaces)} — ignored in dock model (still honored in classic dashboard)`,
          );
        }
        const finalSrc = resolvedIframeUrl ?? tab.iframeUrl;
        panelsContrib.push({
          pluginName: p.name,
          id: tab.id,
          fullType: `plugin:${p.name}:${tab.id}`,
          title: tab.label,
          icon: tab.icon,
          type: finalSrc ? 'iframe' : 'react',
          componentRoot: tab.componentRoot ?? pluginRoot,
          componentId: tab.componentId,
          src: finalSrc ?? undefined,
        });
      }
      // Native `panels[]` declaration (opt-in by manifests using the new field).
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
      const declared = (p as PluginManifest & { panels?: PanelDecl[] }).panels ?? [];
      for (const panel of declared) {
        let resolvedSrc = panel.src ?? panel.iframeUrl;
        if (!resolvedSrc && panel.iframeUrlConfigKey) {
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

  return NextResponse.json({
    project: { slug, path: projectPath },
    dashboardTabs, sidebarItems, routes,
    panels: panelsContrib,
  });
}
