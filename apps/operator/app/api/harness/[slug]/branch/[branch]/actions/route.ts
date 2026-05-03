/**
 * GET /api/harness/<slug>/branch/<branch>/actions
 *
 * Lists discoverable actions for the branch — both harness-shipped
 * (.harness/actions/<branch>/*.sh) and plugin-contributed (each enabled
 * plugin's papercusp.json `branchActions`).
 *
 * Each action is enriched with:
 *   - manifest:   declared env requirements + display metadata
 *   - envStatus:  { resolved: [...], missing: [...] } based on current
 *                 plugin-configs and harness env.json
 *   - lastRun:    most recent run's terminal status (or null)
 *
 * Spec: per-branch action registry; envStatus drives the chip's
 * "⚠ keys needed" indicator.
 */

import { NextResponse } from 'next/server';
import { join } from 'node:path';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { papercuspPath } from '@/lib/papercusp-root';
import { isBranch, listActions, listRuns } from '@/lib/branch-actions';
import { resolveEnv } from '@/lib/branch-action-manifest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Params { params: Promise<{ slug: string; branch: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { slug, branch } = await params;
  if (!isBranch(branch)) {
    return NextResponse.json({ error: 'invalid branch' }, { status: 400 });
  }
  const reg = loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: 'unknown project' }, { status: 404 });

  const harnessConfigsDir = papercuspPath('harnesses', slug);
  const globalPluginsDir = papercuspPath('global-plugins');

  const actions = await listActions(project.path, branch, {
    harnessConfigsDir, globalPluginsDir,
  });

  // Request-scoped cache shared across all per-action resolveEnv calls.
  // Many actions reference the same plugin-config files (e.g. all
  // @papercupai/cloudflare-pages actions hit the same .json), so sharing
  // the cache turns N×M reads into N+1. See /docs/performance #A1.
  const envReadCache = new Map<string, Promise<unknown>>();

  const enriched = await Promise.all(actions.map(async (a) => {
    const runs = await listRuns(project.path, branch, a.name);
    const envResolution = a.manifest?.env
      ? await resolveEnv(a.manifest, { harnessConfigsDir, contributingPlugin: a.pluginSlug, readCache: envReadCache })
      : { env: {}, missing: [] };
    return {
      name: a.name,
      source: a.source,
      pluginSlug: a.pluginSlug,
      displayName: a.manifest?.displayName ?? a.name,
      description: a.manifest?.description,
      scriptPath: a.scriptPath,
      env: a.manifest?.env ?? null,
      envStatus: {
        ok: envResolution.missing.length === 0,
        resolved: Object.keys(envResolution.env),
        missing: envResolution.missing,
      },
      lastRun: runs[0] ?? null,
    };
  }));
  return NextResponse.json({ branch, actions: enriched });
}
