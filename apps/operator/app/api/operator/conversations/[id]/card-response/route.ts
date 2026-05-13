/**
 * POST /api/operator/conversations/:id/card-response
 *
 * Resolves a pending `ctx.askUser` card from a tool run.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.5
 *
 * Auth: session cookie required (401 if missing).
 * Rate limit: 30 RPS sliding window per session user.id (NOT per
 *   caller-supplied workspaceId — that field is untrusted).
 * Defense-in-depth: card-correlator validates expectedWorkspaceId
 *   against the card's stored workspaceId — cross-workspace replay
 *   returns 404 even if a caller bypasses the auth check.
 *
 * Body:
 *   { correlationId, action: 'submit'|'decline'|'cancel',
 *     workspaceId, payload?, reason? }
 */

import { NextRequest, NextResponse } from 'next/server';

import { resolveCardResponse } from '@papercusp/agent-mcp';

import { getSessionUser } from '@/lib/auth';
import { cardResponseRateAllow } from '@/lib/card-response-rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  correlationId: string;
  action: 'submit' | 'decline' | 'cancel';
  workspaceId: string;
  payload?: unknown;
  reason?: string;
}

export async function POST(
  req: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  // 1. Session-cookie auth.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Parse + validate body.
  const body = (await req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.correlationId !== 'string' ||
    body.correlationId.length === 0 ||
    typeof body.workspaceId !== 'string' ||
    body.workspaceId.length === 0 ||
    (body.action !== 'submit' && body.action !== 'decline' && body.action !== 'cancel')
  ) {
    return NextResponse.json(
      { error: 'correlationId, workspaceId, action required; action ∈ {submit,decline,cancel}' },
      { status: 400 },
    );
  }

  // 3. Rate limit — keyed on session user.id (NOT body.workspaceId,
  // which is caller-supplied and could be varied to bypass).
  if (!cardResponseRateAllow(user.id)) {
    return NextResponse.json(
      { error: 'rate limit: 30 RPS per user' },
      { status: 429 },
    );
  }

  // 4. Resolve via card-correlator. expectedWorkspaceId provides
  //    cross-workspace defense-in-depth (returns 404 on mismatch).
  const r = resolveCardResponse({
    correlationId: body.correlationId,
    action: body.action,
    payload: body.payload,
    reason: body.reason,
    expectedWorkspaceId: body.workspaceId,
  });

  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, ...(r.details ? { details: r.details } : {}) },
      { status: r.status },
    );
  }
  return NextResponse.json({ ok: true });
}
