/**
 * GET /api/plugins/enabled
 *   → { enabled: { <harness>: [pluginSlug, ...], ... } }
 *
 * GET /api/plugins/enabled?plugin=<slug>
 *   → { plugin, byHarness: { <harness>: boolean, ... } }
 *
 * Reads from `<workspace-root>/harnesses/<slug>/enabled-plugins.json`, the
 * source of truth scoped to the active workspace. `harness_shared.plugin_enables`
 * (PG) is workspace-blind — querying it would return enabled state from
 * every workspace blended together, which made marketplace-candidate
 * filtering and per-workspace UI lie. PG is still mirrored on writes for
 * cross-harness Zero queries elsewhere; this read path stays on the filesystem.
 */
import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filterPlugin = url.searchParams.get('plugin');
  const enabled = await listEnabledFromJson();
  if (filterPlugin) {
    const byHarness: Record<string, boolean> = {};
    for (const [h, slugs] of Object.entries(enabled)) byHarness[h] = slugs.includes(filterPlugin);
    return NextResponse.json({ plugin: filterPlugin, byHarness });
  }
  return NextResponse.json({ enabled });
}

async function listEnabledFromJson(): Promise<Record<string, string[]>> {
  const dir = papercuspPath('harnesses');
  const out: Record<string, string[]> = {};
  let harnesses: string[] = [];
  try { harnesses = await fs.readdir(dir); } catch { return out; }
  for (const h of harnesses) {
    try {
      const raw = await fs.readFile(join(dir, h, 'enabled-plugins.json'), 'utf8');
      const parsed = JSON.parse(raw) as { enabled?: Record<string, unknown> };
      out[h] = Object.keys(parsed.enabled ?? {});
    } catch { /* skip */ }
  }
  return out;
}
