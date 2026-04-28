/**
 * GET /api/plugins/enabled
 *   → { enabled: { <harness>: [pluginSlug, ...], ... } }
 *
 * GET /api/plugins/enabled?plugin=<slug>
 *   → { plugin, byHarness: { <harness>: boolean, ... } }
 *
 * Reads from harness_shared.plugin_enables (PG, Zero-synced). The CLI is
 * still the source-of-truth writer for ~/.papercusp/harnesses/<slug>/
 * enabled-plugins.json; the operator API mirrors writes into PG via
 * mirrorHarness(). If a direct CLI invocation outside the operator drifts
 * the two, run scripts/backfill-plugin-enables.mjs.
 */
import { NextResponse } from 'next/server';
import { listEnabledByHarness } from '../../../../lib/plugin-enables-pg';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filterPlugin = url.searchParams.get('plugin');
  const enabled = await listEnabledByHarness();
  if (filterPlugin) {
    const byHarness: Record<string, boolean> = {};
    for (const [h, slugs] of Object.entries(enabled)) byHarness[h] = slugs.includes(filterPlugin);
    return NextResponse.json({ plugin: filterPlugin, byHarness });
  }
  return NextResponse.json({ enabled });
}
