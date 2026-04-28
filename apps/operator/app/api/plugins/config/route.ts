import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { mirrorHarness } from '../../../../lib/plugin-enables-pg';
import { mirrorPluginConfig } from '../../../../lib/plugin-configs-pg';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET  /api/plugins/config?harness=<h>&plugin=<dir-basename>
 *      → { config: <object> }
 *
 * PUT  /api/plugins/config  body: { harness, plugin, config }
 *      → { ok, configHash }
 *
 * Reads/writes the per-harness plugin config file at
 * `~/.papercusp/harnesses/<h>/plugin-configs/<plugin>.json`. Used by the
 * harness page's config→Plugins panel inline editor.
 *
 * Plugin slug is the on-disk dir basename (`docs-viewer`), not the
 * scoped manifest name (`@papercupai/docs-viewer`) — same convention as
 * `enable`/`disable`/`uninstall`.
 *
 * Save also bumps the harness's `enabled-plugins.json` configHash so the
 * substrate's plugin loader sees the change on next reload.
 */
const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');

const HARNESS_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLUGIN_DIR_SLUG = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;

function configHash(config: Record<string, unknown>): string {
  return 'sha256-' + createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 32);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const harness = url.searchParams.get('harness') ?? '';
  const plugin = url.searchParams.get('plugin') ?? '';
  if (!HARNESS_SLUG.test(harness)) return NextResponse.json({ error: 'invalid harness' }, { status: 400 });
  if (!PLUGIN_DIR_SLUG.test(plugin)) return NextResponse.json({ error: 'invalid plugin slug' }, { status: 400 });
  const path = join(HARNESSES_DIR, harness, 'plugin-configs', `${plugin}.json`);
  const config = (await readJson<Record<string, unknown>>(path)) ?? {};
  return NextResponse.json({ config });
}

export async function PUT(req: Request) {
  let body: { harness?: string; plugin?: string; config?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }

  const harness = String(body.harness ?? '').trim();
  const plugin = String(body.plugin ?? '').trim();
  if (!HARNESS_SLUG.test(harness)) return NextResponse.json({ ok: false, error: 'invalid harness' }, { status: 400 });
  if (!PLUGIN_DIR_SLUG.test(plugin)) return NextResponse.json({ ok: false, error: 'invalid plugin slug' }, { status: 400 });
  const cfg = body.config;
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
    return NextResponse.json({ ok: false, error: 'config must be a JSON object' }, { status: 400 });
  }

  const configPath = join(HARNESSES_DIR, harness, 'plugin-configs', `${plugin}.json`);
  await writeJson(configPath, cfg);
  try { await mirrorPluginConfig(harness, plugin, cfg as Record<string, unknown>); } catch (e) {
    console.warn('[plugins/config] PG config mirror failed for', harness, plugin, e);
  }

  // Bump enabled-plugins.json configHash so the substrate sees the change.
  const enabledPath = join(HARNESSES_DIR, harness, 'enabled-plugins.json');
  const enabled = (await readJson<{ enabled: Record<string, { version: string; enabledAt: string; configHash: string }> }>(enabledPath))
    ?? { enabled: {} };
  if (enabled.enabled[plugin]) {
    enabled.enabled[plugin].configHash = configHash(cfg as Record<string, unknown>);
    await writeJson(enabledPath, enabled);
    try { await mirrorHarness(harness); } catch (e) {
      console.warn('[plugins/config] PG mirror failed for', harness, e);
    }
  }

  return NextResponse.json({
    ok: true,
    harness,
    plugin,
    configHash: configHash(cfg as Record<string, unknown>),
    path: configPath,
  });
}
