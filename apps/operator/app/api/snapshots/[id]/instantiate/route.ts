import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { restore, readManifestFromTarball } from '@papercusp/export-state';
import { findSnapshot, readRegistry } from '@/lib/snapshot-discovery';
import { withSnapshotLock } from '@/lib/snapshot-locks';
import { mirrorPluginConfig } from '@/lib/plugin-configs-pg';
import { resolveAliases, type ConfigSchema } from '@/lib/snapshot-shape';

import { papercuspPath } from '@/lib/papercusp-root';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

const PROJECTS_DIR = papercuspPath('projects');
const REGISTRY_PATH = papercuspPath('registry.json');

interface Body {
  /** Optional human-friendly slug suffix the user supplied. Defaults to the
   *  fork-suffix the lib generates. We rename after restore if provided. */
  name?: string;
  acceptPartial?: boolean;
  rewriteAmbiguousSlugs?: boolean;
  /**
   * Per-plugin config overrides supplied by the fork-completion UI to
   * fill in `shareable: false` and `secret: true` fields the snapshot
   * stripped. Applied AFTER restore() persists the redacted base config.
   * Map: pluginSlug → field overrides.
   */
  pluginConfigOverrides?: Record<string, Record<string, unknown>>;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;
  return withSnapshotLock(id, () => instantiate(id, body));
}

async function instantiate(id: string, body: Body): Promise<NextResponse> {
  const snap = await findSnapshot(id);
  if (!snap) return NextResponse.json({ ok: false, error: 'snapshot not found' }, { status: 404 });

  // Validate user-provided name (if any) before doing real work. Hyphens
  // are not valid in unquoted Postgres identifiers, so we collapse runs
  // of any non-[a-z0-9._] character to a single underscore — same approach
  // the lib's `_fork_` convention takes.
  let userName: string | undefined;
  if (typeof body.name === 'string' && body.name.trim()) {
    const sanitized = body.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!/^[a-z0-9][a-z0-9._]{0,63}$/i.test(sanitized)) {
      return NextResponse.json({ ok: false, error: `invalid name "${body.name}"` }, { status: 400 });
    }
    const reg = await readRegistry();
    if (reg.projects.some((p) => p.slug === sanitized)) {
      return NextResponse.json(
        { ok: false, error: `harness "${sanitized}" already exists` },
        { status: 409 },
      );
    }
    userName = sanitized;
  }

  try {
    const result = await restore({
      snapshotPath: snap.tarballPath,
      targetProjectsDir: PROJECTS_DIR,
      substrateVersion: '0.0.1',
      schemaVersionDb: 0,
      acceptPartial: !!body.acceptPartial,
      ambiguousMatchPolicy: body.rewriteAmbiguousSlugs ? 'rewrite-all' : 'skip-all',
      consent: 'grant-all',
    });

    // If user supplied a custom name, rename the schema + project dir +
    // registry entry. Otherwise the lib's default `<orig>_fork_<6-base32>`
    // stands. On rename failure we leave the lib-default state intact
    // rather than half-rolled-back; lib already wrote the registry.
    if (userName && userName !== result.newSlug) {
      try {
        await renameHarness(result.newSlug, userName, result.projectDir);
      } catch (e: unknown) {
        return NextResponse.json(
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

    // Apply share-semantics: per-plugin overrides for stripped fields +
    // resolve schema-evolution aliases against the *current* installed
    // manifest. This lets a snapshot taken under v0.1 fork into a v0.2
    // installation that renamed a field. Runs against `finalSlug`, so it
    // works whether or not the user supplied a custom name.
    let applied: { applied: string[]; warnings: string[] } | undefined;
    if (body.pluginConfigOverrides) {
      // Load the snapshot's preserved (post-extractShape) configs from the
      // manifest; restore() writes them to disk under different naming
      // conventions, so we read them back from the source-of-truth.
      let snapshotPreservedConfigs: Record<string, Record<string, unknown>> = {};
      try {
        const manifest = await readManifestFromTarball(snap.tarballPath);
        for (const p of manifest.plugins ?? []) {
          if (!p.name) continue;
          try {
            snapshotPreservedConfigs[p.name] = JSON.parse(p.configJson) as Record<string, unknown>;
          } catch { /* skip malformed */ }
        }
      } catch {
        // Manifest read failed — fall through with empty preserved configs.
      }
      applied = await applyForkOverrides(finalSlug, body.pluginConfigOverrides, snapshotPreservedConfigs);
    }

    return NextResponse.json({
      ok: true,
      newSlug: finalSlug,
      projectDir: join(PROJECTS_DIR, finalSlug),
      warnings: [...(result.warnings ?? []), ...(applied?.warnings ?? [])],
      ambiguousSlugMatches: result.ambiguousSlugMatches,
      ...(applied ? { appliedOverrides: applied.applied } : {}),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

const HARNESSES_DIR = papercuspPath('harnesses');
const GLOBAL_PLUGINS_DIR = papercuspPath('global-plugins');

async function applyForkOverrides(
  newSlug: string,
  overrides: Record<string, Record<string, unknown>>,
  snapshotPreservedConfigs: Record<string, Record<string, unknown>> = {},
): Promise<{ applied: string[]; warnings: string[] }> {
  const applied: string[] = [];
  const warnings: string[] = [];
  for (const [pluginSlug, fields] of Object.entries(overrides)) {
    const cfgPath = join(HARNESSES_DIR, newSlug, 'plugin-configs', `${pluginSlug}.json`);
    // Base = the snapshot's preserved (post-extractShape) config. The
    // restore-written file (if any) overlays on top of this; user
    // overrides overlay last.
    let existing: Record<string, unknown> = snapshotPreservedConfigs[pluginSlug] ?? {};
    try {
      const onDisk = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>;
      existing = { ...existing, ...onDisk };
    } catch {
      // No file on disk — manifest preserved config is our only base.
    }
    // Run alias resolution against the installed manifest (not the
    // snapshot's manifest) so renames in the *current* schema take effect.
    let installedSchema: ConfigSchema | undefined;
    try {
      const m = JSON.parse(
        await fs.readFile(join(GLOBAL_PLUGINS_DIR, pluginSlug, 'papercusp.json'), 'utf8'),
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
    // Plugin slugs with `/` (npm-scoped names like `@papercupai/foo`) need
    // the nested scope directory to exist; mkdir the cfg's parent dir.
    await fs.mkdir(dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(merged, null, 2) + '\n');
    try {
      await mirrorPluginConfig(newSlug, pluginSlug, merged);
    } catch {
      // Best-effort PG mirror; file is authoritative.
    }
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
  const url =
    process.env.HARNESS_ADMIN_DATABASE_URL ??
    'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`ALTER SCHEMA harness_${oldSlug} RENAME TO harness_${newSlug}`);
  } finally {
    await sql.end({ timeout: 5 });
  }

  const newDir = join(PROJECTS_DIR, newSlug);
  await fs.rename(oldProjectDir, newDir).catch(async () => {
    // Cross-device fallback: copy then unlink
    await copyDir(oldProjectDir, newDir);
    await fs.rm(oldProjectDir, { recursive: true, force: true });
  });

  const reg = JSON.parse(await fs.readFile(REGISTRY_PATH, 'utf8')) as {
    projects: { slug: string; path: string }[];
  };
  for (const p of reg.projects) {
    if (p.slug === oldSlug) {
      p.slug = newSlug;
      p.path = newDir;
    }
  }
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n');
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
