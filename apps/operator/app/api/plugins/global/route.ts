import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/plugins/global — list every plugin installed under
 * ~/.papercusp/global-plugins/. Manifest-only (papercusp.json), no entry
 * import. Bypasses the Hono catch-all `[[...route]]` to avoid that route's
 * pre-existing orchestrator-import compile cost (~8-13s in dev).
 */
const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const GLOBAL_PLUGINS_DIR = join(PAPERCUSP_ROOT, 'global-plugins');

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  icon?: string;
  dashboardTabs?: Array<{ id?: string; label?: string; icon?: string }>;
  [k: string]: unknown;
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

export async function GET() {
  if (!existsSync(GLOBAL_PLUGINS_DIR)) return NextResponse.json({ plugins: [] });
  const entries = await fs.readdir(GLOBAL_PLUGINS_DIR, { withFileTypes: true }).catch(() => []);
  const plugins: Array<PluginManifest & { source: string; path: string }> = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDirOrLinkToDir = e.isDirectory();
    if (!isDirOrLinkToDir && e.isSymbolicLink()) {
      const stat = await fs.stat(join(GLOBAL_PLUGINS_DIR, e.name)).catch(() => null);
      isDirOrLinkToDir = stat?.isDirectory() ?? false;
    }
    if (!isDirOrLinkToDir) continue;
    const dir = join(GLOBAL_PLUGINS_DIR, e.name);
    const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
    if (!m?.name || !m?.version) continue;
    plugins.push({ ...m, source: 'global', path: dir });
  }
  return NextResponse.json({ plugins });
}
