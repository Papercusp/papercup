import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { invokePluginAction } from '@/lib/plugin-host-runtime';
import { papercuspPath } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PLUGIN_SLUG = /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i;
const HARNESS_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ACTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;


/**
 * Resolve the project's source-tree path. Plugins write their run.log.jsonl
 * events into `<projectPath>/.harness/logs/run.log.jsonl` because that's
 * where the harness's run.sh + the operator's SSE tail both look. Falls
 * back through workspace registry → legacy file → null.
 */
async function resolveProjectPath(slug: string): Promise<string | null> {
  const { loadHarnessRegistry } = await import('@/lib/harness-registry');
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

export async function POST(req: Request) {
  let body: { slug?: string; action?: string; harness?: string; params?: Record<string, unknown> };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }

  const slug = String(body.slug ?? '').trim();
  const action = String(body.action ?? '').trim();
  const harness = String(body.harness ?? '').trim();

  if (!PLUGIN_SLUG.test(slug)) return NextResponse.json({ ok: false, error: `invalid plugin slug` }, { status: 400 });
  if (!ACTION_ID.test(action)) return NextResponse.json({ ok: false, error: `invalid action id` }, { status: 400 });
  if (!HARNESS_SLUG.test(harness)) return NextResponse.json({ ok: false, error: `invalid harness slug` }, { status: 400 });

  // Plugin-config tree (CLI's harnessDir convention) — where configs +
  // plugin-data files live. Same as `papercusp plugin invoke` would use.
  const harnessDataDir = papercuspPath('harnesses', harness);
  if (!existsSync(harnessDataDir)) {
    return NextResponse.json({
      ok: false, slug, action, harness,
      error: `harness "${harness}" data dir missing at ${harnessDataDir} — has it been provisioned via 'papercusp project add'?`,
    }, { status: 404 });
  }

  // Project-source tree — where the run.log.jsonl the LogView SSE tails
  // actually lives. Plugin events MUST land here so they appear in the
  // run.log panel alongside harness lines. Optional: if there's no
  // project registry entry, fall back to the harness data dir (logs go
  // somewhere only the CLI sees, but the invocation still runs).
  const projectPath = await resolveProjectPath(harness);
  const stateDir = projectPath ? join(projectPath, '.harness') : harnessDataDir;
  const projectDir = projectPath ?? harnessDataDir;

  // The plugin reads its config from <pluginDataDir>/config.json. Configs
  // live under the harness DATA dir (CLI's convention), not the project's
  // source tree. Override pluginDataDir explicitly so the host doesn't
  // compute it relative to stateDir.
  const pluginDataDirOverride = join(harnessDataDir, 'plugin-data', slug);

  try {
    const r = await invokePluginAction({
      pluginName: slug,
      actionName: action,
      installSlug: harness,
      projectDir,
      stateDir,
      pluginDataDirOverride,
      params: body.params,
      triggerSource: 'ui',
    });
    if (!r.ok) {
      return NextResponse.json({
        ok: false, slug, action, harness,
        error: r.error ?? 'unknown error',
        result: r.result,
      }, { status: 500 });
    }
    const resultStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
    return NextResponse.json({
      ok: true, slug, action, harness,
      result: resultStr,
      structuredResult: r.result,
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false, slug, action, harness,
      error: e?.message ?? String(e),
    }, { status: 500 });
  }
}
