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
  let harnesses: string[] = [];
  try { harnesses = await fs.readdir(dir); } catch { return {}; }
  // Parallel reads. Next.js dev mode instruments every fs.readFile call (for
  // HMR file-tracking), which adds ~150ms overhead per call. Serial 68×150ms
  // = 10s; parallel collapses to single-call latency. Measured 2026-05-03:
  // 10.9s → ~150ms in dev, no measurable change in production.
  const results = await Promise.all(harnesses.map(async (h) => {
    try {
      const raw = await fs.readFile(join(dir, h, 'enabled-plugins.json'), 'utf8');
      const parsed = JSON.parse(raw) as { enabled?: Record<string, unknown> };
      return [h, Object.keys(parsed.enabled ?? {})] as const;
    } catch {
      return null;
    }
  }));
  const out: Record<string, string[]> = {};
  for (const r of results) {
    if (r) out[r[0]] = r[1];
  }
  return out;
}
