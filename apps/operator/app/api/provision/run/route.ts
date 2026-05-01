/**
 * POST /api/provision/run
 *
 * Drives one provision phase (setup | teardown | verify) for a
 * (harness, plugin) pair. Reads the plugin's manifest + per-harness
 * config from the substrate's standard locations and invokes runPhase.
 *
 * Body: { harness, plugin, phase, consentConfirmed }
 *
 * Spec: /docs/snapshots/build-scripts.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { runPhase, type ProvisionPhase } from '@/lib/provision/runner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 900;

const HARNESSES_DIR = papercuspPath('harnesses');
const GLOBAL_PLUGINS_DIR = papercuspPath('global-plugins');

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

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const harness = body.harness ?? '';
  const plugin = body.plugin ?? '';
  const phase = body.phase;
  if (!harness || !plugin || !phase) {
    return NextResponse.json(
      { ok: false, error: 'harness, plugin, phase required' },
      { status: 400 },
    );
  }
  if (!['setup', 'teardown', 'verify'].includes(phase)) {
    return NextResponse.json({ ok: false, error: 'invalid phase' }, { status: 400 });
  }

  const pluginDir = join(GLOBAL_PLUGINS_DIR, plugin);
  const manifest = await readJson<PluginManifest>(join(pluginDir, 'papercusp.json'));
  if (!manifest) {
    return NextResponse.json(
      { ok: false, error: `plugin "${plugin}" not installed` },
      { status: 404 },
    );
  }
  if (!manifest.provision) {
    return NextResponse.json(
      { ok: false, error: 'plugin has no provision scripts declared' },
      { status: 400 },
    );
  }

  const config =
    (await readJson<Record<string, unknown>>(
      join(HARNESSES_DIR, harness, 'plugin-configs', `${plugin}.json`),
    )) ?? {};

  const result = await runPhase(phase, {
    harness,
    plugin,
    publisher: manifest.publisher ?? 'unknown',
    pluginVersion: manifest.version ?? '0.0.0',
    pluginDir,
    config,
    provision: manifest.provision,
    consentConfirmed: !!body.consentConfirmed,
  });

  return NextResponse.json(result);
}
