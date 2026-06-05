/**
 * POST /api/snapshots/create
 *
 * Creates a snapshot of a harness — captures fs + plugin configs (redacted),
 * applies share-semantics, wraps with recordUserAction.
 *
 * Ported from app/api/snapshots/create/route.ts. `auth: 'public'` — flag-gated.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  capture,
  isBundledPlugin,
  readCapturePluginExtras,
  type SnapshotPlugin,
} from '@papercusp/export-state';
import { findProject } from '../../../snapshot-discovery';
import { indexSnapshot, readTarballSha } from '../../../snapshot-index';
import { redactPluginConfig } from '../../../snapshot-config-redact';
import { extractShape, type ConfigSchema } from '../../../snapshot-shape';
import { papercuspPath } from '../../../papercusp-root';
import { recordUserAction } from '../../../user-actions';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { defineTool } from '@papercusp/agent-mcp';

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
  includeSecretsConfirmed?: boolean;
}

function HARNESSES_DIR() { return papercuspPath('harnesses'); }

export default defineTool({
  method: 'POST',
  path: '/snapshots/create',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    let body: CreateBody;
    try {
      body = (await req.json()) as CreateBody;
    } catch {
      return Response.json({ ok: false, error: 'invalid json body' }, { status: 400 });
    }
    const slug = String(body.slug ?? '').trim();
    if (!slug) {
      return Response.json({ ok: false, error: 'slug required' }, { status: 400 });
    }

    const project = await findProject(slug);
    if (!project) {
      return Response.json({ ok: false, error: `unknown harness "${slug}"` }, { status: 404 });
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
        // Hybrid FS+PG home (D-010): write the PG discovery index row alongside
        // the FS tarball. Best-effort — the tarball is the source of truth and
        // the discovery FS-reconcile sweep back-fills a missed row, so a failed
        // index write must not fail the create.
        try {
          await indexSnapshot(r.manifest, {
            tarballPath: r.tarballPath,
            bytes: r.bytesCompressed,
            contentHash: await readTarballSha(r.tarballPath),
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[snapshot] index-row write failed for ${r.manifest.id} (discovery will reconcile):`, e);
        }
        return {
          summary: `Snapshot ${r.manifest.id} created (${r.manifest.files.length} files, ${(r.bytesCompressed / 1024).toFixed(1)} KB)`,
          result: r,
        };
      });
      return Response.json({
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
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }
  },
});

async function readTemplate(slug: string): Promise<{ name: string; version: string }> {
  try {
    const raw = await fs.readFile(join(HARNESSES_DIR(), slug, 'papercusp.json'), 'utf8');
    const m = JSON.parse(raw) as { name?: string; version?: string };
    return { name: m.name ?? slug, version: m.version ?? '0.0.0' };
  } catch {
    return { name: slug, version: '0.0.0' };
  }
}

// TODO(D-004, couples to BRIEF A / E1-E2): the snapshot currently BUNDLES plugin
// defs into the manifest here. Per D-004 this bundling moves UP to the blueprint
// dep-manifest (declare + resolve from the Cupboard, don't embed). Left as-is
// until the E1/E2 owner lands the dep-manifest — coordinate before removing.
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
        // malformed configJson — fall through to legacy redactor
      }
    }

    const redacted = redactPluginConfig({ configJson: shapedConfigJson, uiSchema });
    out.push({
      name: pluginSlug,
      version: info.version,
      capabilities: caps,
      configJson: redacted.configJson,
      ...(shapeJson ? { shapeJson } : {}),
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
