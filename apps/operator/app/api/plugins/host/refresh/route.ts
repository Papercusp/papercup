/**
 * POST /api/plugins/host/refresh — drop the cached plugin-host state
 * and trigger fresh discovery. Used after symlinking new plugins into
 * `~/.papercusp/global-plugins/` or fixing manifest issues, since the
 * host caches discovery on `globalThis` to survive Next HMR.
 *
 * Returns the full status payload so callers can see which plugins
 * loaded, which failed, and the wiring errors.
 */
import { NextResponse } from 'next/server';
import {
  _resetPluginHostForTests,
  captureReloadStates,
  getPluginHost,
  pluginHostStatus,
} from '@/lib/plugin-host-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    // Save reload state for plugins that opted in BEFORE wiping the host
    // — the reset clears the `initialized` set we iterate over.
    await captureReloadStates();
    _resetPluginHostForTests();
    await getPluginHost();
    return NextResponse.json({ ok: true, status: await pluginHostStatus() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[plugins/host/refresh] POST failed:', err);
    return NextResponse.json({ ok: false, error: message, stack }, { status: 500 });
  }
}

/**
 * GET — read-only status without resetting the host cache. Useful for
 * observing live `initializedPairs` and `registeredActions` after plugin
 * actions have run, since POST /refresh always wipes those.
 */
export async function GET() {
  await getPluginHost();
  return NextResponse.json({ ok: true, status: await pluginHostStatus() });
}
