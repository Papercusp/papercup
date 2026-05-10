/**
 * Plugin capability grants API — Tier 2 of the two-tier capability check.
 *
 * GET  /api/plugins/grants?harness=<slug>&plugin=<name>&version=<v>
 *      → { capabilities: string[] }    user-granted caps for the pair
 *
 * POST /api/plugins/grants  body:
 *      { plugin, version, harness, capabilities, action: 'grant' | 'revoke' }
 *
 * Backed by `harness_shared.plugin_capability_grants` (Migration 051).
 */

import { NextResponse } from 'next/server';
import {
  getGrantsForPluginInHarness,
  grantCapabilities,
  revokeCapabilities,
} from '@/lib/plugin-grants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const plugin = url.searchParams.get('plugin') ?? '';
  const version = url.searchParams.get('version') ?? '';
  const harness = url.searchParams.get('harness') ?? '';
  if (!plugin || !version) {
    return NextResponse.json({ error: 'plugin + version required' }, { status: 400 });
  }
  const capabilities = await getGrantsForPluginInHarness(plugin, version, harness);
  return NextResponse.json({ capabilities });
}

interface PostBody {
  plugin: string;
  version: string;
  harness: string;
  capabilities: string[];
  action?: 'grant' | 'revoke';
  reason?: string;
}

export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (!body.plugin || !body.version) {
    return NextResponse.json({ ok: false, error: 'plugin + version required' }, { status: 400 });
  }
  const caps = Array.isArray(body.capabilities) ? body.capabilities.filter((c) => typeof c === 'string') : [];
  if (caps.length === 0) {
    return NextResponse.json({ ok: false, error: 'capabilities[] required' }, { status: 400 });
  }
  const action = body.action ?? 'grant';
  if (action === 'revoke') {
    await revokeCapabilities({
      pluginName: body.plugin,
      pluginVersion: body.version,
      harnessSlug: body.harness ?? '',
      capabilities: caps,
    });
  } else {
    await grantCapabilities({
      pluginName: body.plugin,
      pluginVersion: body.version,
      harnessSlug: body.harness ?? '',
      capabilities: caps,
      grantedBy: 'user',
      reason: body.reason ?? 'install consent',
    });
  }
  return NextResponse.json({ ok: true });
}
