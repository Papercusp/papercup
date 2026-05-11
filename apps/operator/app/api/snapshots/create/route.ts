import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  capture,
  isBundledPlugin,
  readCapturePluginExtras,
  type SnapshotPlugin,
} from '@papercusp/export-state';
import { findProject } from '@/lib/snapshot-discovery';
import { redactPluginConfig } from '@/lib/snapshot-config-redact';
import { extractShape, type ConfigSchema } from '@/lib/snapshot-shape';

import { papercuspPath } from '@/lib/papercusp-root';
import { recordUserAction } from '@/lib/user-actions';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

interface CreateBody {
  slug: string;
  name?: string;
  description?: string;
  license?: string;
  includeGit?: boolean;
  includeAgentTranscripts?: boolean;
  includeOperatorNotes?: boolean;
  acceptSoftCap?: boolean;
  acceptVerifiedSecrets?: boolean;
  /** Confirm `--include-secrets` for plugins with `snapshotPolicy: "include"` fields. */
  includeSecretsConfirmed?: boolean;
}

function HARNESSES_DIR() { return papercuspPath('harnesses'); }

export async function POST(req: Request) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }
  const slug = String(body.slug ?? '').trim();
  if (!slug) {
    return NextResponse.json({ ok: false, error: 'slug required' }, { status: 400 });
  }

  const project = await findProject(slug);
  if (!project) {
    return NextResponse.json({ ok: false, error: `unknown harness "${slug}"` }, { status: 404 });
  }

  const template = await readTemplate(slug);
  const plugins = await readEnabledPlugins(slug, { includeSecretsConfirmed: !!body.includeSecretsConfirmed });

  try {
    const result = await recordUserAction(slug, 'snapshot.create', async () => {
      const r = await capture({
        harnessSlug: slug,
        projectDir: project.path,
        template,
        substrateVersion: '0.0.1',
        schemaVersionDb: 0,
        minSubstrateVersion: '0.0.1',
        name: body.name ?? `${slug} snapshot @ ${new Date().toISOString().slice(0, 16)}`,
        description: body.description,
        license: body.license ?? 'MIT',
        plugins,
        capture: {
          includeGit: !!body.includeGit,
          includeAgentTranscripts: !!body.includeAgentTranscripts,
          includeOperatorNotes: !!body.includeOperatorNotes,
        },
        drainMode: 'interactive',
        acceptVerifiedSecrets: !!body.acceptVerifiedSecrets,
        acceptSoftCap: !!body.acceptSoftCap,
      });
      return {
        summary: `Snapshot ${r.manifest.id} created (${r.manifest.files.length} files, ${(r.bytesCompressed / 1024).toFixed(1)} KB)`,
        result: r,
      };
    });
    return NextResponse.json({
      ok: true,
      id: result.manifest.id,
      tarballPath: result.tarballPath,
      bytes: result.bytesCompressed,
      durationMs: result.durationMs,
      filesCount: result.manifest.files.length,
      warnings: result.warnings,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

async function readTemplate(slug: string): Promise<{ name: string; version: string }> {
  try {
    const raw = await fs.readFile(join(HARNESSES_DIR(), slug, 'papercusp.json'), 'utf8');
    const m = JSON.parse(raw) as { name?: string; version?: string };
    return { name: m.name ?? slug, version: m.version ?? '0.0.0' };
  } catch {
    return { name: slug, version: '0.0.0' };
  }
}

async function readEnabledPlugins(
  slug: string,
  opts: { includeSecretsConfirmed: boolean },
): Promise<SnapshotPlugin[]> {
  const enabledPath = join(HARNESSES_DIR(), slug, 'enabled-plugins.json');
  let enabled: { enabled: Record<string, { version: string }> };
  try {
    enabled = JSON.parse(await fs.readFile(enabledPath, 'utf8'));
  } catch {
    return [];
  }
  const out: SnapshotPlugin[] = [];
  for (const [pluginSlug, info] of Object.entries(enabled.enabled ?? {})) {
    const dir = papercuspPath('global-plugins', pluginSlug);
    let caps: string[] = [];
    let uiSchema: unknown = undefined;
    let configSchema: ConfigSchema | undefined;
    let pinExtras: ReturnType<typeof readCapturePluginExtras> = {
      versionPin: { mode: 'semver' },
      pluginVersionPinned: false,
    };
    let isBundled = false;
    try {
      const m = JSON.parse(await fs.readFile(join(dir, 'papercusp.json'), 'utf8')) as {
        capabilities?: unknown;
        uiSchema?: unknown;
        configSchema?: unknown;
        pluginVersionPinned?: unknown;
        versionPin?: unknown;
        runtime?: unknown;
        bundled?: unknown;
      };
      if (Array.isArray(m.capabilities)) {
        caps = m.capabilities.filter((c): c is string => typeof c === 'string');
      }
      uiSchema = m.uiSchema;
      if (m.configSchema && typeof m.configSchema === 'object') {
        configSchema = m.configSchema as ConfigSchema;
      }
      pinExtras = readCapturePluginExtras(m);
      isBundled = isBundledPlugin(m);
    } catch { /* empty */ }
    // Per rev3 plan G+5 / A10: bundled plugins ship with the operator
    // install; they're substrate, not user state. Skip from snapshot —
    // a fork's new install will already have them via its own bundled
    // set.
    if (isBundled) {
      // eslint-disable-next-line no-console
      console.log(`[snapshot] excluding bundled plugin from snapshot.plugins[]: ${pluginSlug}`);
      continue;
    }
    let configJson = '{}';
    try {
      configJson = await fs.readFile(
        join(HARNESSES_DIR(), slug, 'plugin-configs', `${pluginSlug}.json`),
        'utf8',
      );
    } catch { /* empty */ }

    // 1) Apply explicit per-field share-semantics flags (extractShape).
    let shapeJson: string | undefined;
    let shapedConfigJson = configJson;
    if (configSchema) {
      try {
        const cfg = JSON.parse(configJson || '{}') as Record<string, unknown>;
        const { redactedConfig, shape } = extractShape(configSchema, cfg, {
          includeSecretsConfirmed: opts.includeSecretsConfirmed,
        });
        shapedConfigJson = JSON.stringify(redactedConfig, null, 2);
        shapeJson = JSON.stringify(shape);
        if (shape.warnings.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`[snapshot] shape warnings for ${pluginSlug}:`, shape.warnings);
        }
      } catch {
        // malformed configJson — fall through to legacy redactor only
      }
    }

    // 2) Apply legacy uiSchema:password redactor as defense-in-depth.
    const redacted = redactPluginConfig({ configJson: shapedConfigJson, uiSchema });
    out.push({
      name: pluginSlug,
      version: info.version,
      capabilities: caps,
      configJson: redacted.configJson,
      ...(shapeJson ? { shapeJson } : {}),
      // v2 canonical fields written first; legacy pluginVersionPinned
      // kept for one cycle so older readers still understand. Drop
      // legacy after one release cycle.
      ...(pinExtras.runtime ? { runtime: pinExtras.runtime } : {}),
      versionPin: pinExtras.versionPin,
      pluginVersionPinned: pinExtras.pluginVersionPinned,
    } as SnapshotPlugin);
    if (redacted.redactedKeys.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[snapshot] redacted ${redacted.redactedKeys.length} password field(s) from ${pluginSlug}: ${redacted.redactedKeys.join(', ')}`);
    }
  }
  return out;
}
