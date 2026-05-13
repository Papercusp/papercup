/**
 * POST /api/operator/conversations/:id/run-cancel
 *
 * Cancels every pending ctx.askUser card under a given runId. Each
 * card's deferred resolves with `{action:'cancel'}`, the card-correlator
 * republishes the run's snapshot with the cards dropped, and the chat
 * surface clears.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §7.2
 *
 * Auth: session cookie required (401 if missing).
 * Rate limit: same per-user 30 RPS bucket as /card-response (cancel
 *   is just another kind of response from the limiter's POV).
 *
 * Body: { runId: string, workspaceId: string }
 *
 * Returns: { ok: true, cancelledRunId } on success; 404 if the
 *   workspaceId doesn't match the runId's stored workspace
 *   (defense-in-depth — same model as /card-response).
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  cancelPendingCardsForRun,
  snapshotWorkspace,
} from '@papercusp/agent-mcp';

import { getSessionUser } from '@/lib/auth';
import { cardResponseRateAllow } from '@/lib/card-response-rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  runId: string;
  workspaceId: string;
}

export async function POST(
  req: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.runId !== 'string' ||
    body.runId.length === 0 ||
    typeof body.workspaceId !== 'string' ||
    body.workspaceId.length === 0
  ) {
    return NextResponse.json(
      { error: 'runId, workspaceId required' },
      { status: 400 },
    );
  }

  if (!cardResponseRateAllow(user.id)) {
    return NextResponse.json(
      { error: 'rate limit: 30 RPS per user' },
      { status: 429 },
    );
  }

  // Defense-in-depth: confirm the runId belongs to the claimed workspace.
  // snapshotWorkspace returns every open run scoped to the workspace; if
  // our runId isn't there, the caller is either wrong about the workspace
  // OR the run already closed (cancel is a no-op either way).
  const runs = snapshotWorkspace(body.workspaceId);
  const ownsRun = runs.some((vs) => vs.runId === body.runId);
  if (!ownsRun) {
    // 404 (not 403) matches /card-response's not-found-on-mismatch behavior.
    return NextResponse.json(
      { error: 'run not found in workspace' },
      { status: 404 },
    );
  }

  cancelPendingCardsForRun(body.runId);

  return NextResponse.json({ ok: true, cancelledRunId: body.runId });
}
