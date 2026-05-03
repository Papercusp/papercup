/**
 * GET /api/harness/<slug>/branch/<branch>/actions
 *
 * Lists discoverable actions at <staging>/.harness/actions/<branch>/*.sh.
 *
 * Spec: per-branch action registry (substrate piece 1 of 3).
 */

import { NextResponse } from 'next/server';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { isBranch, listActions, listRuns } from '@/lib/branch-actions';

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

  const actions = await listActions(project.path, branch);
  // Pull last-run summary per action so the UI can render a "last deploy" badge.
  const enriched = await Promise.all(actions.map(async (a) => {
    const runs = await listRuns(project.path, branch, a.name);
    return { name: a.name, scriptPath: a.scriptPath, lastRun: runs[0] ?? null };
  }));
  return NextResponse.json({ branch, actions: enriched });
}
