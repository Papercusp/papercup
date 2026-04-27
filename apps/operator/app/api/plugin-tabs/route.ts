// Plugin-tab discovery for the harness UI. Walks the operator's
// ~/.papercusp/{global-plugins, harnesses/<slug>/enabled-plugins.json}
// state and returns the enabled plugins for a given harness, with their
// iframe URL extracted from configSchema defaults + per-harness config
// overrides.
//
// Gated by PAPERCUSP_TABS_FROM_PLUGINS=1 server-side so the harness UI
// can toggle the legacy hard-coded tabs in lockstep.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.papercusp');
const GLOBAL_PLUGINS = join(ROOT, 'global-plugins');
const HARNESSES = join(ROOT, 'harnesses');

interface ManifestSubset {
  name: string;
  version: string;
  kind?: 'plugin' | 'template';
  description?: string;
  dashboardTabs?: Array<{ id: string; label: string; icon?: string }>;
  configSchema?: { properties?: Record<string, { default?: unknown }> };
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; }
  catch { return null; }
}

async function listPluginDirs(parent: string): Promise<string[]> {
  // Two-level walk for scoped names (@owner/pkg).
  try {
    const out: string[] = [];
    const entries = await fs.readdir(parent, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('@')) {
        const inner = await fs.readdir(join(parent, e.name), { withFileTypes: true }).catch(() => []);
        for (const i of inner) {
          if (i.isDirectory()) out.push(`${e.name}/${i.name}`);
        }
      } else {
        out.push(e.name);
      }
    }
    return out;
  } catch {
    return [];
  }
}

interface PluginTab {
  pluginSlug: string;
  pluginVersion: string;
  tabId: string;
  label: string;
  icon: string | null;
  iframeUrl: string | null;
}

/** Pull the iframe URL the plugin wants to embed. We read the per-harness
 *  config first (operator-tweaked) then fall back to the manifest default.
 *  The plugins we ship today (vscode-server, pi-coding, docs-viewer) all use
 *  one of these conventional config keys. */
function pluginIframeUrl(manifest: ManifestSubset, harnessConfig: Record<string, unknown> | null, harnessSlug: string): string | null {
  const conventionalKeys = ['codeServerUrl', 'piUrl', 'docsUrl'];
  const props = manifest.configSchema?.properties ?? {};
  for (const k of conventionalKeys) {
    if (k in props || (harnessConfig && k in harnessConfig)) {
      const fromConfig = harnessConfig?.[k];
      const fromDefault = props[k]?.default;
      const url = (typeof fromConfig === 'string' ? fromConfig : null)
        ?? (typeof fromDefault === 'string' ? fromDefault : null);
      if (!url) return null;
      // Append harness param so the plugin can scope to the right project.
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}harness=${encodeURIComponent(harnessSlug)}`;
    }
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const harnessSlug = url.searchParams.get('harness');
  if (!harnessSlug) {
    return Response.json({ error: 'harness query param required' }, { status: 400 });
  }
  const enableFlag = process.env.PAPERCUSP_TABS_FROM_PLUGINS === '1';
  // Always return the list (so the UI can show "no plugins enabled" state),
  // but include the enableFlag so the UI knows whether to act on it.
  const enabled = await readJson<{ enabled: Record<string, { version: string }> }>(
    join(HARNESSES, harnessSlug, 'enabled-plugins.json'),
  );
  if (!enabled || Object.keys(enabled.enabled ?? {}).length === 0) {
    return Response.json({ enableFlag, plugins: [] });
  }
  const installedSlugs = new Set(await listPluginDirs(GLOBAL_PLUGINS));
  const tabs: PluginTab[] = [];
  for (const slug of Object.keys(enabled.enabled)) {
    if (!installedSlugs.has(slug)) continue;
    const manifest = await readJson<ManifestSubset>(join(GLOBAL_PLUGINS, slug, 'papercusp.json'));
    if (!manifest) continue;
    if (!Array.isArray(manifest.dashboardTabs)) continue;
    const harnessConfig = await readJson<Record<string, unknown>>(
      join(HARNESSES, harnessSlug, 'plugin-configs', `${slug}.json`),
    );
    const iframeUrl = pluginIframeUrl(manifest, harnessConfig, harnessSlug);
    for (const tab of manifest.dashboardTabs) {
      tabs.push({
        pluginSlug: slug,
        pluginVersion: manifest.version,
        tabId: tab.id,
        label: tab.label,
        icon: tab.icon ?? null,
        iframeUrl,
      });
    }
  }
  return Response.json({ enableFlag, plugins: tabs });
}
