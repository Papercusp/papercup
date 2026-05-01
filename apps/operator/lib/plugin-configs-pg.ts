/**
 * Plugin-configs PG mirror.
 *
 * The substrate plugin loader (apps/operator/app/api/_hono/plugins.ts) reads
 * `~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json` at runtime,
 * so the file is authoritative. This mirror exists for cross-harness reads
 * and Zero subscriptions ("which harnesses have plugin X configured how?").
 *
 * Contract:
 *   - Every API route that mutates a plugin-config file MUST call
 *     `mirrorPluginConfig(harness, plugin)` immediately after.
 *   - If a direct CLI invocation outside the operator UI drifts the file
 *     ahead of PG, run `scripts/backfill-plugin-configs.mjs` to reconcile.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@restart/db-org';

import { papercuspPath } from '@/lib/papercusp-root';
const HARNESSES_DIR = papercuspPath('harnesses');

async function readJsonFile<T>(p: string): Promise<T | null> {
  if (!existsSync(p)) return null;
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return null; }
}

/** Mirror one plugin-config JSON into PG. Pass `null` cfg to delete. */
export async function mirrorPluginConfig(
  harness: string,
  plugin: string,
  cfg: Record<string, unknown> | null = null,
): Promise<void> {
  const { sql } = getOrgPg();
  if (cfg === null) {
    // Re-read from disk (caller may have just written it).
    const path = join(HARNESSES_DIR, harness, 'plugin-configs', `${plugin}.json`);
    cfg = (await readJsonFile<Record<string, unknown>>(path)) ?? {};
  }
  await sql`
    INSERT INTO harness_shared.plugin_configs (harness_slug, plugin_slug, config, updated_at)
    VALUES (${harness}, ${plugin}, ${sql.json(cfg)}, now())
    ON CONFLICT (harness_slug, plugin_slug) DO UPDATE
      SET config = EXCLUDED.config, updated_at = now()
  `;
}

/** Drop a plugin-config row (used when a plugin is disabled/uninstalled). */
export async function deletePluginConfig(harness: string, plugin: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.plugin_configs
    WHERE harness_slug = ${harness} AND plugin_slug = ${plugin}
  `;
}
