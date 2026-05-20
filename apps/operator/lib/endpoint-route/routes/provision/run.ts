/**
 * POST /api/provision/run
 *
 * Drives one provision phase (setup | teardown | verify) for a
 * (harness, plugin) pair. Reads the plugin manifest + per-harness config
 * from the substrate's standard locations and invokes `runPhase`.
 *
 * Ported from app/api/provision/run/route.ts. `auth: 'public'`.
 * `timeoutSec: 900` — the handler awaits `runPhase`, a long provision
 * operation; this preserves the Next route's `maxDuration = 900`.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { runPhase, type ProvisionPhase } from '@/lib/provision/runner';
import { defineRoute } from '../../define-route';

function HARNESSES_DIR() { return papercuspPath('harnesses'); }
function GLOBAL_PLUGINS_DIR() { return papercuspPath('global-plugins'); }
function PROJECTS_DIR() { return papercuspPath('projects'); }

interface Body {
  harness?: string;
  plugin?: string;
  phase?: ProvisionPhase;
  consentConfirmed?: boolean;
}

interface PluginManifest {
  name?: string;
  version?: string;
  publisher?: string;
  provision?: {
    setup?: { path: string; timeoutSec?: number };
    teardown?: { path: string; timeoutSec?: number };
    verify?: { path: string; timeoutSec?: number };
    cloudProvider?: { id: string; region?: string; regions?: string[] };
    allowedHosts?: string[];
    skipReprovisionOnPatch?: boolean;
    auditLogCapMb?: number;
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export default defineRoute({
  method: 'POST',
  path: '/provision/run',
  auth: 'public',
  timeoutSec: 900,
  async handler(req) {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    const harness = body.harness ?? '';
    const plugin = body.plugin ?? '';
    const phase = body.phase;
    if (!harness || !plugin || !phase) {
      return Response.json(
        { ok: false, error: 'harness, plugin, phase required' },
        { status: 400 },
      );
    }
    if (!['setup', 'teardown', 'verify'].includes(phase)) {
      return Response.json({ ok: false, error: 'invalid phase' }, { status: 400 });
    }

    const pluginDir = join(GLOBAL_PLUGINS_DIR(), plugin);
    const manifest = await readJson<PluginManifest>(join(pluginDir, 'papercusp.json'));
    if (!manifest) {
      return Response.json(
        { ok: false, error: `plugin "${plugin}" not installed` },
        { status: 404 },
      );
    }
    if (!manifest.provision) {
      return Response.json(
        { ok: false, error: 'plugin has no provision scripts declared' },
        { status: 400 },
      );
    }

    const config =
      (await readJson<Record<string, unknown>>(
        join(HARNESSES_DIR(), harness, 'plugin-configs', `${plugin}.json`),
      )) ?? {};

    // Resolve the harness's project dir if it exists; the runner will
    // mount it RW and expose it via $PAPERCUSP_PROJECT_DIR. Plugins that
    // template project files need this; API-only plugins work without it.
    const projectDirCandidate = join(PROJECTS_DIR(), harness);
    let projectDir: string | undefined;
    try {
      const stat = await fs.stat(projectDirCandidate);
      if (stat.isDirectory()) projectDir = projectDirCandidate;
    } catch { /* project dir absent: leave undefined */ }

    const result = await runPhase(phase, {
      harness,
      plugin,
      publisher: manifest.publisher ?? 'unknown',
      pluginVersion: manifest.version ?? '0.0.0',
      pluginDir,
      projectDir,
      config,
      provision: manifest.provision,
      consentConfirmed: !!body.consentConfirmed,
    });

    return Response.json(result);
  },
});
