/**
 * GET /api/plugins/enabled
 *   → { enabled: { <harness>: [pluginSlug, ...], ... } }
 *
 * GET /api/plugins/enabled?plugin=<slug>
 *   → { plugin, byHarness: { <harness>: boolean, ... } }
 *
 * PG-canonical via `harness_shared.plugin_enables`, scoped to the active
 * workspace (RLS GUC set by `withWorkspace`). The papercusp CLI is the
 * source-of-truth WRITER for `~/.papercusp/harnesses/<slug>/enabled-plugins.json`;
 * `harness-fs-watcher` mirrors that file into PG on every add/change/unlink
 * + a cold-start reconcile sweep, so direct CLI invocations outside the
 * operator API no longer drift the read path.
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
