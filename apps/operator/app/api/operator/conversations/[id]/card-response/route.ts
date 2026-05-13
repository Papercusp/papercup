/**
 * POST /api/operator/conversations/:id/card-response
 *
 * Resolves a pending `ctx.askUser` card from a tool run.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.5
 *
 * Auth: session cookie required (401 if missing).
 * Rate limit: 30 RPS sliding window per (workspaceId).
 * Defense-in-depth: card-correlator validates expectedWorkspaceId against
 *   the card's stored workspaceId — even if the route's session check is
 *   bypassed (e.g. a server-side caller), cross-workspace reads return 404.
 *
 * Body:
 *   { correlationId, action: 'submit'|'decline'|'cancel',
 *     workspaceId, payload?, reason? }
 */

import { NextRequest, NextResponse } from 'next/server';

import { resolveCardResponse } from '@papercusp/agent-mcp';

import { getSessionUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  correlationId: string;
  action: 'submit' | 'decline' | 'cancel';
  workspaceId: string;
  payload?: unknown;
  reason?: string;
}

const RATE_WINDOW_MS = 1000;
const RATE_LIMIT = 30;

interface RateBucket {
  /** Wall-clock ms timestamps within the window. */
  ts: number[];
}

const __SYM = Symbol.for('papercusp.cardResponseRateLimiter');
type RateGlobals = typeof globalThis & {
  [__SYM]?: Map<string /* workspaceId */, RateBucket>;
};
function rateBuckets(): Map<string, RateBucket> {
  const g = globalThis as RateGlobals;
  if (!g[__SYM]) g[__SYM] = new Map();
  return g[__SYM]!;
}

/** Returns true when the request should proceed; false when 429. */
function rateAllow(workspaceId: string): boolean {
  const now = Date.now();
  const buckets = rateBuckets();
  let b = buckets.get(workspaceId);
  if (!b) {
    b = { ts: [] };
    buckets.set(workspaceId, b);
  }
  // Drop timestamps outside the window.
  while (b.ts.length > 0 && now - b.ts[0] > RATE_WINDOW_MS) {
    b.ts.shift();
  }
  if (b.ts.length >= RATE_LIMIT) return false;
  b.ts.push(now);
  return true;
}

/** Test-only: clear the rate buckets. */
export function _resetCardResponseRateLimitForTests(): void {
  rateBuckets().clear();
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

  // 3. Rate limit (per workspace).
  if (!rateAllow(body.workspaceId)) {
    return NextResponse.json(
      { error: 'rate limit: 30 RPS per workspace' },
      { status: 429 },
    );
  }

  // 4. Resolve via card-correlator.
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
