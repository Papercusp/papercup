/**
 * GET /api/plugins/host/runtime-status — surface non-JS runtime
 * status for the operator's installed-plugins UI (Batch I8 + the
 * mirror for WASM).
 *
 * Returns one entry per loaded plugin whose runtime.kind is wasm or
 * daemon. JS plugins are omitted (their state lives in the existing
 * action registry / hook bus surfaces).
 *
 * Response:
 *   [{ plugin, runtime, pid?, restartCount?, lastExitCode?, ok }]
 */
import { NextResponse } from 'next/server';
import { getPluginHost } from '@/lib/plugin-host-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RuntimeStatusRow {
  plugin: string;
  runtime: 'wasm' | 'daemon';
  pid?: number;
  restartCount?: number;
  ok: boolean;
  loadedFor: string[]; // installSlugs
}

export async function GET(): Promise<Response> {
  const state = await getPluginHost();
  const rows: RuntimeStatusRow[] = [];

  // Group by plugin name; one plugin can be enabled in multiple slugs
  // (each (plugin, slug) gets its own wasmHandles entry).
  const byPlugin = new Map<string, { runtime: 'wasm' | 'daemon'; slugs: string[]; handles: unknown[] }>();
  for (const [key, handle] of state.wasmHandles) {
    const [pluginName, slug] = key.split('::');
    if (!pluginName) continue;
    const lp = state.loaded.find((p) => p.plugin.name === pluginName);
    const rk = lp?.runtime?.kind === 'daemon' ? 'daemon' : 'wasm';
    let entry = byPlugin.get(pluginName);
    if (!entry) {
      entry = { runtime: rk, slugs: [], handles: [] };
      byPlugin.set(pluginName, entry);
    }
    if (slug) entry.slugs.push(slug);
    entry.handles.push(handle);
  }

  for (const [plugin, entry] of byPlugin) {
    // Daemon handles expose pid() + restartCount().
    let pid: number | undefined;
    let restartCount: number | undefined;
    if (entry.runtime === 'daemon') {
      const h = entry.handles[0] as { pid?: () => number | undefined; restartCount?: () => number };
      try {
        pid = typeof h?.pid === 'function' ? h.pid() : undefined;
        restartCount = typeof h?.restartCount === 'function' ? h.restartCount() : undefined;
      } catch { /* handle gone */ }
    }
    rows.push({
      plugin,
      runtime: entry.runtime,
      pid,
      restartCount,
      ok: entry.handles.length > 0,
      loadedFor: entry.slugs,
    });
  }

  return NextResponse.json({ rows });
}
