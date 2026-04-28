import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

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
const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');
const GLOBAL_PLUGINS_DIR = join(PAPERCUSP_ROOT, 'global-plugins');
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');

interface DashboardTabManifest {
  id: string; label: string; icon?: string;
  componentId?: string; componentRoot?: string;
  iframeUrl?: string; iframeUrlConfigKey?: string;
  replaces?: string[];
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
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
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

interface RegistryShape { projects: Array<{ slug: string; path: string }> }

async function resolveProjectPath(slug: string): Promise<string | null> {
  const reg = (await readJson<RegistryShape>(REGISTRY_PATH))
    ?? (await readJson<RegistryShape>(LEGACY_REGISTRY_PATH))
    ?? { projects: [] };
  return reg.projects.find((p) => p.slug === slug)?.path ?? null;
}

function resolveIframeUrl(
  manifest: PluginManifest,
  tab: DashboardTabManifest,
  harnessConfig: Record<string, unknown> | null,
  harnessSlug: string,
): string | null {
  let url: string | null = null;
  if (tab.iframeUrlConfigKey) {
    const k = tab.iframeUrlConfigKey;
    const fromConfig = harnessConfig?.[k];
    const fromDefault = manifest.configSchema?.properties?.[k]?.default;
    if (typeof fromConfig === 'string' && fromConfig.length > 0) url = fromConfig;
    else if (typeof fromDefault === 'string' && fromDefault.length > 0) url = fromDefault;
  }
  if (!url && typeof tab.iframeUrl === 'string' && tab.iframeUrl.length > 0) {
    url = tab.iframeUrl;
  }
  if (!url) return null;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}harness=${encodeURIComponent(harnessSlug)}`;
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
  if (existsSync(HARNESSES_DIR)) {
    const harnessDirs = await fs.readdir(HARNESSES_DIR, { withFileTypes: true }).catch(() => []);
    for (const h of harnessDirs) {
      if (!h.isDirectory()) continue;
      sources.push({ name: h.name, dir: join(HARNESSES_DIR, h.name, 'plugins'), source: 'harness' });
    }
  }
  sources.push({ name: 'global', dir: GLOBAL_PLUGINS_DIR, source: 'global' });

  // Per-harness opt-in for global plugins.
  type EnabledFile = { enabled: Record<string, { version: string }> };
  const enabledFile = await readJson<EnabledFile>(
    join(HARNESSES_DIR, slug, 'enabled-plugins.json'),
  );
  const enabledSet = new Set<string>(enabledFile ? Object.keys(enabledFile.enabled) : []);

  const seen = new Set<string>();
  type Tab = DashboardTabManifest & { pluginName: string };
  type Item = SidebarItemManifest & { pluginName: string };
  type Route = UiContributionManifest & { pluginName: string };
  const dashboardTabs: Tab[] = [];
  const sidebarItems: Item[] = [];
  const routes: Route[] = [];

  for (const s of sources) {
    for (const p of await listPluginsIn(s.dir, s.source)) {
      if (seen.has(p.name)) continue;
      const dirBasename = basename(p.path);
      if (s.source === 'global' && !(enabledSet.has(p.name) || enabledSet.has(dirBasename))) continue;
      seen.add(p.name);
      const pluginRoot = (p as PluginManifest & { componentRoot?: string }).componentRoot;
      const harnessConfig = await readJson<Record<string, unknown>>(
        join(HARNESSES_DIR, slug, 'plugin-configs', `${p.name}.json`),
      );
      for (const tab of p.dashboardTabs ?? []) {
        const resolvedIframeUrl = resolveIframeUrl(p, tab, harnessConfig, slug);
        dashboardTabs.push({
          componentRoot: tab.componentRoot ?? pluginRoot,
          ...tab,
          iframeUrl: resolvedIframeUrl ?? tab.iframeUrl,
          pluginName: p.name,
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
  });
}
