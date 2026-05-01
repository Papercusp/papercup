/**
 * Plugin-enables PG mirror.
 *
 * The papercusp CLI is the source-of-truth WRITER for
 * `~/.papercusp/harnesses/<slug>/enabled-plugins.json`. This module mirrors
 * that JSON into `harness_shared.plugin_enables` so READ paths can use one
 * cross-harness PG query (and Zero) instead of fanning over the filesystem.
 *
 * Contract:
 *   - Every API route that mutates the JSON (directly or by shelling to the
 *     CLI) MUST call `mirrorHarness(slug)` immediately after.
 *   - PG is treated as a derived index of the JSON. If they diverge, the
 *     JSON wins and a re-mirror reconciles. Use the
 *     `scripts/backfill-plugin-enables.mjs` script if a direct CLI run
 *     outside the operator UI drifted them.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@restart/db-org';

import { papercuspPath } from '@/lib/papercusp-root';
const HARNESSES_DIR = papercuspPath('harnesses');

interface EnabledFile {
  enabled: Record<string, { version: string; enabledAt: string; configHash: string }>;
}

async function readEnabled(harness: string): Promise<EnabledFile | null> {
  const p = join(HARNESSES_DIR, harness, 'enabled-plugins.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as EnabledFile; } catch { return null; }
}

/** Mirror a single harness's enabled-plugins.json into PG. */
export async function mirrorHarness(harness: string): Promise<void> {
  const file = await readEnabled(harness);
  const enabled = file?.enabled ?? {};
  const slugs = Object.keys(enabled);
  const { sql } = getOrgPg();
  for (const [pluginSlug, meta] of Object.entries(enabled)) {
    await sql`
      INSERT INTO harness_shared.plugin_enables
        (harness_slug, plugin_slug, version, config_hash, enabled_at, updated_at)
      VALUES (${harness}, ${pluginSlug}, ${meta.version ?? ''}, ${meta.configHash ?? ''},
              ${meta.enabledAt ?? new Date().toISOString()}, now())
      ON CONFLICT (harness_slug, plugin_slug) DO UPDATE
        SET version = EXCLUDED.version,
            config_hash = EXCLUDED.config_hash,
            updated_at = now()
    `;
  }
  if (slugs.length === 0) {
    await sql`DELETE FROM harness_shared.plugin_enables WHERE harness_slug = ${harness}`;
  } else {
    await sql`
      DELETE FROM harness_shared.plugin_enables
      WHERE harness_slug = ${harness} AND plugin_slug NOT IN ${sql(slugs)}
    `;
  }
}

/** Read every (harness → enabled plugin slugs) mapping from PG. */
export async function listEnabledByHarness(): Promise<Record<string, string[]>> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ harness_slug: string; plugin_slug: string }>>`
    SELECT harness_slug, plugin_slug FROM harness_shared.plugin_enables
    ORDER BY harness_slug, plugin_slug
  `;
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    (out[r.harness_slug] ??= []).push(r.plugin_slug);
  }
  return out;
}

/** For a given plugin slug, which harnesses have it enabled? */
export async function harnessesByPlugin(pluginSlug: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ harness_slug: string }>>`
    SELECT harness_slug FROM harness_shared.plugin_enables
    WHERE plugin_slug = ${pluginSlug}
    ORDER BY harness_slug
  `;
  return rows.map((r) => r.harness_slug);
}
