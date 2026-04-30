import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { capture, type SnapshotPlugin } from '@papercusp/export-state';
import { findProject } from '@/lib/snapshot-discovery';
import { redactPluginConfig } from '@/lib/snapshot-config-redact';

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
}

const HARNESSES_DIR = join(homedir(), '.papercusp', 'harnesses');

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
  const plugins = await readEnabledPlugins(slug);

  try {
    const result = await capture({
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
    const raw = await fs.readFile(join(HARNESSES_DIR, slug, 'papercusp.json'), 'utf8');
    const m = JSON.parse(raw) as { name?: string; version?: string };
    return { name: m.name ?? slug, version: m.version ?? '0.0.0' };
  } catch {
    return { name: slug, version: '0.0.0' };
  }
}

async function readEnabledPlugins(slug: string): Promise<SnapshotPlugin[]> {
  const enabledPath = join(HARNESSES_DIR, slug, 'enabled-plugins.json');
  let enabled: { enabled: Record<string, { version: string }> };
  try {
    enabled = JSON.parse(await fs.readFile(enabledPath, 'utf8'));
  } catch {
    return [];
  }
  const out: SnapshotPlugin[] = [];
  for (const [pluginSlug, info] of Object.entries(enabled.enabled ?? {})) {
    const dir = join(homedir(), '.papercusp', 'global-plugins', pluginSlug);
    let caps: string[] = [];
    let uiSchema: unknown = undefined;
    try {
      const m = JSON.parse(await fs.readFile(join(dir, 'papercusp.json'), 'utf8')) as {
        capabilities?: unknown;
        uiSchema?: unknown;
      };
      if (Array.isArray(m.capabilities)) {
        caps = m.capabilities.filter((c): c is string => typeof c === 'string');
      }
      uiSchema = m.uiSchema;
    } catch { /* empty */ }
    let configJson = '{}';
    try {
      configJson = await fs.readFile(
        join(HARNESSES_DIR, slug, 'plugin-configs', `${pluginSlug}.json`),
        'utf8',
      );
    } catch { /* empty */ }
    // Redact any field marked `ui:widget: "password"` in the plugin's
    // uiSchema. Without this, plugin secrets (e.g. cloudflare-pages-hosted
    // `byoCloudflareToken`) end up in the manifest in plaintext and ship
    // with the published snapshot.
    const redacted = redactPluginConfig({ configJson, uiSchema });
    out.push({ name: pluginSlug, version: info.version, capabilities: caps, configJson: redacted.configJson });
    if (redacted.redactedKeys.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[snapshot] redacted ${redacted.redactedKeys.length} password field(s) from ${pluginSlug}: ${redacted.redactedKeys.join(', ')}`);
    }
  }
  return out;
}
