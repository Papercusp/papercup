import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { mirrorHarness } from '../../../../lib/plugin-enables-pg';
import { mirrorPluginConfig } from '../../../../lib/plugin-configs-pg';
import { listPluginsIn } from '../../_hono/plugins';

import { papercuspRoot } from '@/lib/papercusp-root';
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
 * Plugin slug is the on-disk dir basename (`fumadocs`), not the
 * scoped manifest name (`@papercupai/fumadocs`) — same convention as
 * `enable`/`disable`/`uninstall`.
 *
 * Save also bumps the harness's `enabled-plugins.json` configHash so the
 * substrate's plugin loader sees the change on next reload.
 */

function HARNESSES_DIR() { return join(papercuspRoot(), 'harnesses'); }
function GLOBAL_PLUGINS_DIR() { return join(papercuspRoot(), 'global-plugins'); }

/**
 * Strip any field whose value equals the manifest's schema default. Mirrors
 * `pruneSchemaDefaults` in the CLI's plugin-cli.ts so both write paths leave
 * only true user-overrides on disk; the resolver fills in defaults at read
 * time. Prevents stale-default freeze across plugin upgrades.
 */
function pruneSchemaDefaults(
  config: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return config;
  const properties = ((schema as { properties?: unknown }).properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    const prop = properties[k];
    if (!prop) { out[k] = v; continue; }
    if (prop.type === 'object' && prop.properties && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const pruned = pruneSchemaDefaults(v as Record<string, unknown>, prop);
      if (Object.keys(pruned).length > 0) out[k] = pruned;
      continue;
    }
    if ('default' in prop) {
      const def = prop.default;
      if (Array.isArray(v) && Array.isArray(def)) {
        if (JSON.stringify(v) === JSON.stringify(def)) continue;
      } else if (v === def) {
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

/**
 * Resolve a user-supplied plugin slug (manifest name or dir-basename) to the
 * matching manifest. Used to canonicalise on-disk plugin-config paths around
 * the manifest's `name` so the resolver and the editor agree on which file
 * to read (eliminates the dir-basename vs manifest-name dual-path drift).
 */
async function findPluginManifest(harness: string, inputSlug: string): Promise<{
  schema: Record<string, unknown> | null;
  canonicalName: string;
} | null> {
  const sources = [
    join(HARNESSES_DIR(), harness, 'plugins'),
    GLOBAL_PLUGINS_DIR(),
  ];
  for (const dir of sources) {
    const items = await listPluginsIn(dir, 'global');
    for (const m of items) {
      const dirBase = m.path.split('/').pop();
      if (m.name === inputSlug || dirBase === inputSlug) {
        return {
          schema: (m as { configSchema?: Record<string, unknown> }).configSchema ?? null,
          canonicalName: m.name,
        };
      }
    }
  }
  return null;
}

const HARNESS_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Accepts both scoped npm names (`@papercupai/cloudflare-pages`) and plain
// dir basenames (`fumadocs`). Scoped names are produced by
// `pluginSlugFromPath` whenever a plugin lives under a `@scope/` directory.
const PLUGIN_DIR_SLUG = /^@?[a-z0-9][a-z0-9@._/-]{0,127}$/i;

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
  const m = await findPluginManifest(harness, plugin);
  const canonicalSlug = m?.canonicalName ?? plugin;
  // Read canonical first; fall back to whatever the caller named (handles
  // back-compat with files written under dir-basename before canonicalisation).
  const canonicalPath = join(HARNESSES_DIR(), harness, 'plugin-configs', `${canonicalSlug}.json`);
  const fallbackPath = join(HARNESSES_DIR(), harness, 'plugin-configs', `${plugin}.json`);
  const config =
    (await readJson<Record<string, unknown>>(canonicalPath))
    ?? (await readJson<Record<string, unknown>>(fallbackPath))
    ?? {};
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

  const m = await findPluginManifest(harness, plugin);
  const canonicalSlug = m?.canonicalName ?? plugin;
  const pruned = pruneSchemaDefaults(cfg as Record<string, unknown>, m?.schema ?? null);

  const configPath = join(HARNESSES_DIR(), harness, 'plugin-configs', `${canonicalSlug}.json`);
  await writeJson(configPath, pruned);
  // Migrate-on-write: if the caller used a non-canonical slug and a file
  // exists at that legacy path, retire it now to prevent drift.
  if (canonicalSlug !== plugin) {
    const legacyPath = join(HARNESSES_DIR(), harness, 'plugin-configs', `${plugin}.json`);
    if (existsSync(legacyPath)) {
      try { await fs.unlink(legacyPath); } catch (e) {
        console.warn('[plugins/config] failed to unlink legacy path', legacyPath, e);
      }
    }
  }
  try { await mirrorPluginConfig(harness, canonicalSlug, pruned); } catch (e) {
    console.warn('[plugins/config] PG config mirror failed for', harness, canonicalSlug, e);
  }

  // Bump enabled-plugins.json configHash so the substrate sees the change.
  const enabledPath = join(HARNESSES_DIR(), harness, 'enabled-plugins.json');
  const enabled = (await readJson<{ enabled: Record<string, { version: string; enabledAt: string; configHash: string }> }>(enabledPath))
    ?? { enabled: {} };
  // enabled-plugins.json may key by either canonical or legacy slug; bump
  // whichever entry exists.
  const enabledKey = enabled.enabled[canonicalSlug] ? canonicalSlug
    : enabled.enabled[plugin] ? plugin
    : null;
  if (enabledKey) {
    enabled.enabled[enabledKey].configHash = configHash(pruned);
    await writeJson(enabledPath, enabled);
    try { await mirrorHarness(harness); } catch (e) {
      console.warn('[plugins/config] PG mirror failed for', harness, e);
    }
  }

  return NextResponse.json({
    ok: true,
    harness,
    plugin: canonicalSlug,
    configHash: configHash(pruned),
    path: configPath,
  });
}
