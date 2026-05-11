/**
 * POST /api/plugins/host/invoke — host-mediated RPC for iframe plugin
 * surfaces (Batch H4). Receives an action invocation from a sandboxed
 * iframe via PluginIframe's postMessage bridge, dispatches through the
 * standard plugin-host invoke path, and audits with surface='iframe'.
 *
 * Request shape:
 *   { pluginName, installSlug, actionName, payloadB64, surface }
 *
 * Response shape:
 *   { ok: true, payloadB64 } | { ok: false, error }
 */
import { NextResponse } from 'next/server';
import { invokePluginAction, callWasmAction } from '@/lib/plugin-host-runtime';
import { papercuspRoot } from '@/lib/papercusp-root';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReqBody {
  pluginName: string;
  installSlug: string;
  actionName: string;
  payloadB64: string;
  surface?: 'iframe' | 'react' | 'core';
}

export async function POST(req: Request): Promise<Response> {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  if (!body.pluginName || !body.installSlug || !body.actionName) {
    return NextResponse.json(
      { ok: false, error: 'pluginName, installSlug, actionName required' },
      { status: 400 },
    );
  }

  // First try the WASM/daemon dispatcher; if that returns "not loaded",
  // fall back to the JS plugin invocation path.
  const wasmResult = await callWasmAction({
    pluginName: body.pluginName,
    installSlug: body.installSlug,
    actionName: body.actionName,
    payload: Buffer.from(body.payloadB64 ?? '', 'base64'),
    origin: body.surface === 'iframe' ? 'ui' : 'core',
  });
  if (wasmResult.ok) {
    return NextResponse.json({
      ok: true,
      payloadB64: Buffer.from(wasmResult.payload).toString('base64'),
    });
  }
  // If wasm path explicitly says "not loaded", route to JS path.
  if (!wasmResult.error.includes('no WASM plugin loaded')) {
    return NextResponse.json({ ok: false, error: wasmResult.error });
  }

  try {
    const projectDir = process.cwd();
    const stateDir = join(papercuspRoot(), 'harnesses', body.installSlug);
    const result = await invokePluginAction({
      pluginName: body.pluginName,
      actionName: body.actionName,
      installSlug: body.installSlug,
      projectDir,
      stateDir,
      params: JSON.parse(Buffer.from(body.payloadB64 ?? '', 'base64').toString('utf8') || 'null'),
    });
    if (result.ok) {
      const payloadJson = JSON.stringify(result.result ?? null);
      return NextResponse.json({
        ok: true,
        payloadB64: Buffer.from(payloadJson, 'utf8').toString('base64'),
      });
    }
    return NextResponse.json({ ok: false, error: result.error ?? 'unknown' });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
