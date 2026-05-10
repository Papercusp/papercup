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

// 1-second TTL + single-flight cache keyed by `${slug}:${branch}`. The
// dashboard cold-loads /staging, /testing, /production in parallel; each
// call rebuilds the actions list (filesystem walk over harness + every
// enabled plugin's manifest, then env resolution). Diagnostic 2026-05-06
// measured 1.1s steady-state per call on dev (~3.3s of waterfall on
// dashboard mount). Pinned to globalThis so dev's per-request module
// re-eval doesn't reset it.
type Payload = { branch: string; actions: unknown[] };
const ACTIONS_CACHE_TTL_MS = 1000;
type _G = {
  __branchActionsCache?: Map<string, { ts: number; payload: Payload }>;
  __branchActionsInflight?: Map<string, Promise<Payload>>;
};
const _g = globalThis as unknown as _G;
const cache: Map<string, { ts: number; payload: Payload }> =
  _g.__branchActionsCache ?? (_g.__branchActionsCache = new Map());
const inflight: Map<string, Promise<Payload>> =
  _g.__branchActionsInflight ?? (_g.__branchActionsInflight = new Map());

async function compute(slug: string, branch: string): Promise<Payload | { error: string; status: number }> {
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return { error: 'unknown project', status: 404 };

  const harnessConfigsDir = papercuspPath('harnesses', slug);
  const globalPluginsDir = papercuspPath('global-plugins');

  const actions = await listActions(project.path, branch as 'staging' | 'testing' | 'production', {
    harnessConfigsDir, globalPluginsDir,
  });

  // Request-scoped cache shared across all per-action resolveEnv calls.
  // Many actions reference the same plugin-config files (e.g. all
  // @papercupai/cloudflare-pages actions hit the same .json), so sharing
  // the cache turns N×M reads into N+1. See /docs/performance #A1.
  const envReadCache = new Map<string, Promise<unknown>>();

  const enriched = await Promise.all(actions.map(async (a) => {
    const runs = await listRuns(project.path, branch as 'staging' | 'testing' | 'production', a.name);
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
  return { branch, actions: enriched };
}

export async function GET(_req: Request, { params }: Params) {
  const { slug, branch } = await params;
  if (!isBranch(branch)) {
    return NextResponse.json({ error: 'invalid branch' }, { status: 400 });
  }
  const cacheKey = `${slug}:${branch}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.ts < ACTIONS_CACHE_TTL_MS) {
    return NextResponse.json(hit.payload, {
      headers: { 'X-Cache': 'HIT', 'X-Cache-Age': String(now - hit.ts) },
    });
  }

  const existing = inflight.get(cacheKey);
  if (existing) {
    const payload = await existing;
    return NextResponse.json(payload, { headers: { 'X-Cache': 'COALESCED' } });
  }

  const promise = (async () => {
    const result = await compute(slug, branch);
    if ('error' in result) throw result;
    cache.set(cacheKey, { ts: Date.now(), payload: result });
    if (cache.size > 64) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
      if (oldest) cache.delete(oldest);
    }
    return result;
  })();
  inflight.set(cacheKey, promise);
  try {
    const payload = await promise;
    return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } });
  } catch (e) {
    const err = e as { error?: string; status?: number };
    if (err.error && err.status) {
      return NextResponse.json({ error: err.error }, { status: err.status });
    }
    throw e;
  } finally {
    inflight.delete(cacheKey);
  }
}
