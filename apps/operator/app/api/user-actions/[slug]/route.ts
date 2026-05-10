/**
 * GET /api/user-actions/[slug]
 *
 * Lists long-running user-initiated actions for a harness, newest first.
 * Backs the OperatorActionLog UI panel until the Zero schema gains a
 * user_actions table (then this endpoint becomes a fallback for clients
 * that don't have a Zero subscription).
 *
 * Query params:
 *   limit  — max rows to return (default 50, max 500)
 *   since  — only rows with started_at >= since (ms epoch)
 *
 * Caching: a small in-memory cache (TTL 2s) collapses the dashboard's
 * polling traffic so multiple clients (and multiple effects in one
 * client) only cost one DB roundtrip per slug per 2s window. This
 * avoids the postgres-js cold-reconnect cost (~1.1s) showing up on
 * every poll. The cache key includes `limit` and `since` so distinct
 * queries don't collide.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { ensureUserActionsTable } from '../../../../lib/ensure-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 4.5s TTL — slightly over the OperatorActionLog's 4s poll interval, so
// each poll lands inside the previous poll's still-valid window and gets
// a HIT (the first poll always fills the cache; every subsequent one
// reuses it until TTL). The lag from a write→visibility is bounded at
// TTL (a new replan/cleanup row appears at most 4.5s after it's
// recorded), which matches the polling cadence the user already sees.
const CACHE_TTL_MS = 4500;
type Payload = { actions: unknown[] };
type CacheEntry = { ts: number; payload: Payload };
// Pin the cache + in-flight promise map to `globalThis` so they survive
// Next.js dev's route-module re-evaluations. A plain module-scope const
// resets on every request in dev (Turbopack re-runs the module),
// defeating the whole point.
type _G = {
  __userActionsCache?: Map<string, CacheEntry>;
  __userActionsInFlight?: Map<string, Promise<Payload>>;
};
const _g = globalThis as unknown as _G;
const cache: Map<string, CacheEntry> = _g.__userActionsCache ?? (_g.__userActionsCache = new Map());
const inflight: Map<string, Promise<Payload>> =
  _g.__userActionsInFlight ?? (_g.__userActionsInFlight = new Map());

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ error: 'invalid slug' }, { status: 400 });
  }
  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '50') || 50));
  const since = Number(url.searchParams.get('since') ?? '0') || 0;

  const cacheKey = `${slug}:${limit}:${since}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json(hit.payload, {
      headers: { 'X-Cache': 'HIT', 'X-Cache-Age': String(now - hit.ts) },
    });
  }

  // Single-flight: if another request for the same key is already
  // querying the DB, await its result instead of issuing a duplicate
  // query. This collapses thundering-herd bursts (many polls firing
  // on the same tick) into one DB roundtrip.
  let cacheStatus = 'MISS';
  const existing = inflight.get(cacheKey);
  if (existing) {
    cacheStatus = 'COALESCED';
    const payload = await existing;
    return NextResponse.json(payload, { headers: { 'X-Cache': cacheStatus } });
  }

  const queryPromise = (async (): Promise<Payload> => {
    await ensureUserActionsTable();
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT id, harness_slug, kind, status, summary, detail_url,
             error_text, invocation_id, started_at, finished_at, actor
      FROM harness_shared.user_actions
      WHERE harness_slug = ${slug}
        AND started_at >= ${since}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `) as Array<RowShape>;
    const p: Payload = {
      actions: rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        status: r.status,
        summary: r.summary,
        detailUrl: r.detail_url,
        errorText: r.error_text,
        invocationId: r.invocation_id,
        startedAt: Number(r.started_at),
        finishedAt: r.finished_at == null ? null : Number(r.finished_at),
        actor: r.actor,
      })),
    };
    cache.set(cacheKey, { ts: Date.now(), payload: p });
    if (cache.size > 64) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
      if (oldest) cache.delete(oldest);
    }
    return p;
  })();
  inflight.set(cacheKey, queryPromise);
  try {
    const payload = await queryPromise;
    return NextResponse.json(payload, { headers: { 'X-Cache': cacheStatus } });
  } finally {
    inflight.delete(cacheKey);
  }
}

interface RowShape {
  id: string;
  harness_slug: string;
  kind: string;
  status: string;
  summary: string | null;
  detail_url: string | null;
  error_text: string | null;
  invocation_id: string | null;
  started_at: string;
  finished_at: string | null;
  actor: string | null;
}
