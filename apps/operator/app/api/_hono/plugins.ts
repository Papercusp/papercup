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
 *   GET /:slug/installed   — plugins reachable by the named project
 *   GET /global            — globally installed plugins (no slug needed)
 */
import { Hono } from 'hono';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');
const GLOBAL_PLUGINS_DIR = join(PAPERCUSP_ROOT, 'global-plugins');
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  papercusp?: string;
  plugins?: string[];
  schema?: unknown;
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
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(parent, e.name);
    const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
    if (!m?.name || !m?.version) continue;
    out.push({ ...m, source, path: dir });
  }
  return out;
}

interface RegistryShape {
  projects: Array<{ slug: string; path: string }>;
}

async function resolveProjectPath(slug: string): Promise<string | null> {
  const reg = (await readJson<RegistryShape>(REGISTRY_PATH))
    ?? (await readJson<RegistryShape>(LEGACY_REGISTRY_PATH))
    ?? { projects: [] };
  return reg.projects.find((p) => p.slug === slug)?.path ?? null;
}

export const plugins = new Hono();

plugins.get('/global', async (c) => {
  const items = await listPluginsIn(GLOBAL_PLUGINS_DIR, 'global');
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
  if (existsSync(HARNESSES_DIR)) {
    const harnessDirs = await fs.readdir(HARNESSES_DIR, { withFileTypes: true }).catch(() => []);
    for (const h of harnessDirs) {
      if (!h.isDirectory()) continue;
      sources.push({ name: h.name, dir: join(HARNESSES_DIR, h.name, 'plugins'), source: 'harness' });
    }
  }
  sources.push({ name: 'global', dir: GLOBAL_PLUGINS_DIR, source: 'global' });

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
