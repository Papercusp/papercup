import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { invokePluginAction } from '@/lib/plugin-host-runtime';
import { papercuspPath } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PLUGIN_SLUG = /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i;
const HARNESS_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ACTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export async function POST(req: Request) {
  let body: { slug?: string; action?: string; harness?: string; params?: Record<string, unknown> };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }

  const slug = String(body.slug ?? '').trim();
  const action = String(body.action ?? '').trim();
  const harness = String(body.harness ?? '').trim();

  if (!PLUGIN_SLUG.test(slug)) return NextResponse.json({ ok: false, error: `invalid plugin slug` }, { status: 400 });
  if (!ACTION_ID.test(action)) return NextResponse.json({ ok: false, error: `invalid action id` }, { status: 400 });
  if (!HARNESS_SLUG.test(harness)) return NextResponse.json({ ok: false, error: `invalid harness slug` }, { status: 400 });

  // Use the same harness-data root the papercusp CLI uses for plugin
  // invocations: ~/.papercusp(-workspaces/<id>)/.papercusp/harnesses/<slug>/
  // This is where plugin-configs are saved + mirrored to plugin-data, so
  // the in-process invocation reads the same configs the CLI writes.
  const harnessDir = papercuspPath('harnesses', harness);
  if (!existsSync(harnessDir)) {
    return NextResponse.json({
      ok: false,
      slug, action, harness,
      error: `harness "${harness}" data dir missing at ${harnessDir} — has it been provisioned via 'papercusp project add'?`,
    }, { status: 404 });
  }
  // Both projectDir and stateDir = harnessDir so plugin-host-runtime's
  // pluginDataDir computation (stateDir/plugin-data/<name>) matches the
  // CLI's path.
  const projectDir = harnessDir;
  const stateDir = harnessDir;

  // In-process invocation: runs through plugin-host-runtime's
  // invokePluginAction, which writes structured events to
  // <harness>/.harness/logs/run.log.jsonl (start, ctx.log lines,
  // console.* via AsyncLocalStorage interceptor, final result).
  // Replaces the previous CLI shell-out — same semantics, no spawn cost,
  // unified logging into the run.log panel.
  try {
    const r = await invokePluginAction({
      pluginName: slug,
      actionName: action,
      installSlug: harness,
      projectDir,
      stateDir,
      params: body.params,
      triggerSource: 'ui',
    });
    if (!r.ok) {
      return NextResponse.json({
        ok: false,
        slug, action, harness,
        error: r.error ?? 'unknown error',
        result: r.result,
      }, { status: 500 });
    }
    // result might be an object (the plugin returned structured data) or
    // a string. Stringify objects for backward-compatible UI rendering.
    const resultStr = typeof r.result === 'string'
      ? r.result
      : JSON.stringify(r.result, null, 2);
    return NextResponse.json({
      ok: true, slug, action, harness,
      result: resultStr,
      structuredResult: r.result,
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      slug, action, harness,
      error: e?.message ?? String(e),
    }, { status: 500 });
  }
}
