/**
 * POST /api/harness/<slug>/branch/<branch>/action-run?name=<name>
 *
 * Starts an action run. Returns the runId synchronously; the child runs
 * to completion in the background. Clients tail progress via the sibling
 * /action-stream route.
 *
 * `name` lives in the query string (not the path) because plugin-contributed
 * names can contain `/` and `:` (e.g. `@papercupai/cloudflare-stack:deploy`),
 * which Next.js dynamic-route segments don't accept.
 *
 * Returns 412 if any required env var is missing — the body's `missing[]`
 * tells the UI which plugin to send the user to for configuration.
 *
 * Spec: per-branch action registry (substrate piece 2 of 3).
 */

import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { papercuspPath } from '@/lib/papercusp-root';
import { isBranch, runAction, MissingEnvError } from '@/lib/branch-actions';
import { recordUserAction, updateUserAction } from '@/lib/user-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

interface Params { params: Promise<{ slug: string; branch: string }> }

function resolvePhasePath(stagingPath: string, branch: 'staging' | 'testing' | 'production'): string {
  if (branch === 'staging') return stagingPath;
  try {
    const cfgPath = join(stagingPath, '.harness', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const o = cfg?.phases?.[branch]?.path;
      if (typeof o === 'string' && o.length > 0) return o;
    }
  } catch { /* fall through */ }
  return `${stagingPath}--${branch}`;
}

export async function POST(req: Request, { params }: Params) {
  const { slug, branch } = await params;
  if (!isBranch(branch)) return NextResponse.json({ error: 'invalid branch' }, { status: 400 });

  const url = new URL(req.url);
  const name = url.searchParams.get('name') ?? '';
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  // ?force=1 lets the UI override the missing-env guard after the user
  // explicitly confirms via a "run anyway" affordance.
  const force = url.searchParams.get('force') === '1';

  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: 'unknown project' }, { status: 404 });

  const phasePath = resolvePhasePath(project.path, branch);
  const harnessConfigsDir = papercuspPath('harnesses', slug);
  const globalPluginsDir = papercuspPath('global-plugins');

  let handle;
  try {
    handle = await runAction({
      stagingPath: project.path,
      phasePath,
      harness: slug,
      branch,
      name,
      harnessConfigsDir,
      globalPluginsDir,
      skipEnvCheck: force,
    });
  } catch (e) {
    if (e instanceof MissingEnvError) {
      return NextResponse.json(
        { ok: false, error: 'missing required env', missing: e.missing },
        { status: 412 }, // Precondition Failed — UI knows to surface "configure keys"
      );
    }
    return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
  }

  // Track this as a long-running user action so OperatorActionLog picks it up.
  // Best-effort: if the user_actions table isn't reachable, the run still
  // proceeds; the operator panel just doesn't see it.
  recordUserAction(slug, 'branch.action', async (id) => {
    handle.done
      .then(async (final) => {
        await updateUserAction({
          id,
          status: final.status === 'completed' ? 'succeeded' : 'failed',
          summary: `${branch}/${name} → ${final.status} (${final.exitCode ?? 'no-exit'}, ${final.durationMs ?? 0}ms)`,
          detailUrl: `/harness/${slug}?actionRun=${encodeURIComponent(handle.runId)}`,
          errorText: final.status === 'failed' ? `exit ${final.exitCode}` : undefined,
        }).catch(() => undefined);
      })
      .catch(() => undefined);
    return {
      summary: `Running ${branch}/${name}`,
      detailUrl: `/harness/${slug}?actionRun=${encodeURIComponent(handle.runId)}`,
      invocationId: handle.runId,
      result: undefined,
    };
  }, { async: true }).catch(() => undefined);

  // Don't await `done` — let it run in the background, surface progress via SSE.
  handle.done.catch(() => undefined);

  return NextResponse.json({ ok: true, runId: handle.runId, meta: handle.meta });
}
