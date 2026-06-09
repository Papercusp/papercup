/**
 * POST /api/snapshots/:id/instantiate
 *
 * Forks a snapshot into a new harness. Optional user-supplied name,
 * per-plugin config overrides for stripped fields, alias resolution
 * against the installed manifest, grant carry-over.
 *
 * Ported from app/api/snapshots/[id]/instantiate/route.ts. `auth: 'public'` — flag-gated.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { restore, readManifestFromTarball } from '@papercusp/export-state';
import { findSnapshot, readRegistry } from '../../../snapshot-discovery';
import { withSnapshotLock } from '../../../snapshot-locks';
import { recordUserAction } from '../../../user-actions';
import { mirrorPluginConfig } from '../../../plugin-configs-pg';
import { resolveAliases, type ConfigSchema } from '../../../snapshot-shape';
import { copyGrantsToNewHarness } from '../../../plugin-grants';
import { papercuspPath } from '../../../papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { defineTool } from '@papercusp/agent-mcp';

function PROJECTS_DIR() { return papercuspPath('projects'); }
function REGISTRY_PATH() { return papercuspPath('registry.json'); }
function HARNESSES_DIR() { return papercuspPath('harnesses'); }
function GLOBAL_PLUGINS_DIR() { return papercuspPath('global-plugins'); }

interface Body {
  name?: string;
  acceptPartial?: boolean;
  rewriteAmbiguousSlugs?: boolean;
  pluginConfigOverrides?: Record<string, Record<string, unknown>>;
}

export default defineTool({
  method: 'POST',
  path: '/snapshots/:id/instantiate',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const id = ctx.params.id as string;
    const body = (await req.json().catch(() => ({}))) as Body;
    return withSnapshotLock(id, async () => {
      const snap = await findSnapshot(id);
      const slug = snap?.harnessSlug ?? '_unknown';
      return recordUserAction(slug, 'snapshot.fork', async () => {
        const res = await instantiate(id, body);
        const cloned = res.clone();
        const json = await cloned.json().catch(() => ({})) as { ok?: boolean; slug?: string };
        return {
          summary: json.ok
            ? `Forked ${id} → ${json.slug ?? '?'}`
            : `Fork rejected for ${id}`,
          result: res,
        };
      });
    });
  },
});

async function instantiate(id: string, body: Body): Promise<Response> {
  const snap = await findSnapshot(id);
  if (!snap) return Response.json({ ok: false, error: 'snapshot not found' }, { status: 404 });

  let userName: string | undefined;
  if (typeof body.name === 'string' && body.name.trim()) {
    const sanitized = body.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!/^[a-z0-9][a-z0-9._]{0,63}$/i.test(sanitized)) {
      return Response.json({ ok: false, error: `invalid name "${body.name}"` }, { status: 400 });
    }
    const reg = await readRegistry();
    if (reg.projects.some((p) => p.slug === sanitized)) {
      return Response.json(
        { ok: false, error: `harness "${sanitized}" already exists` },
        { status: 409 },
      );
    }
    userName = sanitized;
  }

  try {
    const result = await restore({
      snapshotPath: snap.tarballPath,
      targetProjectsDir: PROJECTS_DIR(),
      substrateVersion: '0.0.1',
      schemaVersionDb: 0,
      acceptPartial: !!body.acceptPartial,
      ambiguousMatchPolicy: body.rewriteAmbiguousSlugs ? 'rewrite-all' : 'skip-all',
      consent: 'grant-all',
    });

    if (userName && userName !== result.newSlug) {
      try {
        await renameHarness(result.newSlug, userName, result.projectDir);
      } catch (e: unknown) {
        return Response.json(
          {
            ok: false,
            error: `restore succeeded but rename to "${userName}" failed: ${e instanceof Error ? e.message : String(e)}`,
            fallbackSlug: result.newSlug,
            fallbackProjectDir: result.projectDir,
          },
          { status: 500 },
        );
      }
    }

    const finalSlug = userName && userName !== result.newSlug ? userName : result.newSlug;

    if (snap.harnessSlug && snap.harnessSlug !== finalSlug) {
      try {
        await copyGrantsToNewHarness(snap.harnessSlug, finalSlug);
      } catch { /* PG unavailable — silent */ }
    }

    let applied: { applied: string[]; warnings: string[] } | undefined;
    if (body.pluginConfigOverrides) {
      let snapshotPreservedConfigs: Record<string, Record<string, unknown>> = {};
      try {
        const manifest = await readManifestFromTarball(snap.tarballPath);
        for (const p of manifest.plugins ?? []) {
          if (!p.name) continue;
          try {
            snapshotPreservedConfigs[p.name] = JSON.parse(p.configJson) as Record<string, unknown>;
          } catch { /* skip malformed */ }
        }
      } catch { /* manifest read failed */ }
      applied = await applyForkOverrides(finalSlug, body.pluginConfigOverrides, snapshotPreservedConfigs);
    }

    const pendingProvisioning = await listPendingProvisioning(finalSlug);

    return Response.json({
      ok: true,
      newSlug: finalSlug,
      projectDir: join(PROJECTS_DIR(), finalSlug),
      warnings: [...(result.warnings ?? []), ...(applied?.warnings ?? [])],
      ambiguousSlugMatches: result.ambiguousSlugMatches,
      pendingProvisioning,
      ...(applied ? { appliedOverrides: applied.applied } : {}),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

async function applyForkOverrides(
  newSlug: string,
  overrides: Record<string, Record<string, unknown>>,
  snapshotPreservedConfigs: Record<string, Record<string, unknown>> = {},
): Promise<{ applied: string[]; warnings: string[] }> {
  const applied: string[] = [];
  const warnings: string[] = [];
  for (const [pluginSlug, fields] of Object.entries(overrides)) {
    const cfgPath = join(HARNESSES_DIR(), newSlug, 'plugin-configs', `${pluginSlug}.json`);
    let existing: Record<string, unknown> = snapshotPreservedConfigs[pluginSlug] ?? {};
    try {
      const onDisk = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>;
      existing = { ...existing, ...onDisk };
    } catch { /* no file on disk */ }
    let installedSchema: ConfigSchema | undefined;
    try {
      const m = JSON.parse(
        await fs.readFile(join(GLOBAL_PLUGINS_DIR(), pluginSlug, 'papercusp.json'), 'utf8'),
      ) as { configSchema?: ConfigSchema };
      installedSchema = m.configSchema;
    } catch {
      warnings.push(`plugin ${pluginSlug} not installed; overrides applied verbatim`);
    }
    let resolved = existing;
    if (installedSchema) {
      const aliasResult = resolveAliases(installedSchema, existing);
      resolved = aliasResult.config;
      for (const [k, action] of Object.entries(aliasResult.trace)) {
        warnings.push(`plugin ${pluginSlug}: field "${k}" ${action}`);
      }
    }
    const merged = { ...resolved, ...fields };
    await fs.mkdir(dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(merged, null, 2) + '\n');
    try {
      await mirrorPluginConfig(newSlug, pluginSlug, merged);
    } catch { /* file authoritative */ }
    applied.push(pluginSlug);
  }
  return { applied, warnings };
}

async function renameHarness(
  oldSlug: string,
  newSlug: string,
  oldProjectDir: string,
): Promise<void> {
  const postgres = (await import('postgres')).default;
  const { getHarnessAdminUrl } = await import('../../../embedded-pg-discovery');
  const url = getHarnessAdminUrl();
  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`ALTER SCHEMA harness_${oldSlug} RENAME TO harness_${newSlug}`);
  } finally {
    await sql.end({ timeout: 5 });
  }

  const newDir = join(PROJECTS_DIR(), newSlug);
  await fs.rename(oldProjectDir, newDir).catch(async () => {
    await copyDir(oldProjectDir, newDir);
    await fs.rm(oldProjectDir, { recursive: true, force: true });
  });

  const reg = JSON.parse(await fs.readFile(REGISTRY_PATH(), 'utf8')) as {
    projects: { slug: string; path: string }[];
  };
  for (const p of reg.projects) {
    if (p.slug === oldSlug) {
      p.slug = newSlug;
      p.path = newDir;
    }
  }
  await fs.writeFile(REGISTRY_PATH(), JSON.stringify(reg, null, 2) + '\n');
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

interface PendingProvisioningEntry {
  plugin: string;
  publisher?: string;
  version?: string;
  displayName?: string;
  description?: string;
  scriptPath: string;
  allowedHosts?: string[];
  cloudProvider?: { id: string; region?: string; regions?: string[] };
  timeoutSec?: number;
}

interface PluginManifest {
  name?: string;
  version?: string;
  publisher?: string;
  provision?: {
    setup?: {
      path: string;
      displayName?: string;
      description?: string;
      timeoutSec?: number;
    };
    cloudProvider?: { id: string; region?: string; regions?: string[] };
    allowedHosts?: string[];
  };
}

interface EnabledPluginsFile {
  enabled?: Record<string, { version?: string }>;
}

async function listPendingProvisioning(harnessSlug: string): Promise<PendingProvisioningEntry[]> {
  const enabledPath = join(HARNESSES_DIR(), harnessSlug, 'enabled-plugins.json');
  let enabled: EnabledPluginsFile | null = null;
  try {
    enabled = JSON.parse(await fs.readFile(enabledPath, 'utf8')) as EnabledPluginsFile;
  } catch { return []; }
  const slugs = Object.keys(enabled?.enabled ?? {});
  if (slugs.length === 0) return [];

  const results = await Promise.all(slugs.map(async (pluginSlug) => {
    const manifestPath = join(GLOBAL_PLUGINS_DIR(), pluginSlug, 'papercusp.json');
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PluginManifest;
    } catch { return null; }
    const setup = manifest.provision?.setup;
    if (!setup?.path) return null;
    return {
      plugin: pluginSlug,
      publisher: manifest.publisher,
      version: manifest.version,
      displayName: setup.displayName ?? `${pluginSlug} setup`,
      description: setup.description,
      scriptPath: setup.path,
      allowedHosts: manifest.provision?.allowedHosts,
      cloudProvider: manifest.provision?.cloudProvider,
      timeoutSec: setup.timeoutSec,
    } as PendingProvisioningEntry;
  }));
  return results.filter((r): r is PendingProvisioningEntry => r != null);
}
