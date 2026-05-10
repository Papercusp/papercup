/**
 * POST /api/harness/<slug>/branch/<branch>/action/<name>/run
 *
 * Starts an action run. Returns the runId synchronously; the child runs
 * to completion in the background. Clients tail progress via the sibling
 * /stream route.
 *
 * Spec: per-branch action registry (substrate piece 2 of 3).
 */

import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { isBranch, runAction } from '@/lib/branch-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

interface Params { params: Promise<{ slug: string; branch: string; name: string }> }

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

export async function POST(_req: Request, { params }: Params) {
  const { slug, branch, name } = await params;
  if (!isBranch(branch)) return NextResponse.json({ error: 'invalid branch' }, { status: 400 });

  const reg = loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: 'unknown project' }, { status: 404 });

  const phasePath = resolvePhasePath(project.path, branch);

  let handle;
  try {
    handle = await runAction({
      stagingPath: project.path,
      phasePath,
      harness: slug,
      branch,
      name,
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
  }

  // Don't await `done` — let it run in the background, surface progress via SSE.
  handle.done.catch(() => undefined);

  return NextResponse.json({ ok: true, runId: handle.runId, meta: handle.meta });
}
