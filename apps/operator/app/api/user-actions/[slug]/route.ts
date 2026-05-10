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
 * Delegates to listUserActions() in lib/user-actions-data.ts so the
 * same function backs the actions:recent MCP tool. The lib owns the
 * 4.5s in-memory cache + single-flight coalescing — every caller (HTTP
 * + MCP) shares one cache.
 */
import { NextRequest, NextResponse } from 'next/server';
import { InvalidSlugError, listUserActions } from '../../../../lib/user-actions-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '50') || 50;
  const since = Number(url.searchParams.get('since') ?? '0') || 0;

  try {
    const result = await listUserActions({ slug, limit, since });
    return NextResponse.json(
      { actions: result.actions },
      {
        headers:
          result.cacheStatus === 'HIT'
            ? { 'X-Cache': 'HIT', 'X-Cache-Age': String(result.cacheAgeMs) }
            : { 'X-Cache': result.cacheStatus },
      },
    );
  } catch (err) {
    if (err instanceof InvalidSlugError) {
      return NextResponse.json({ error: 'invalid slug' }, { status: 400 });
    }
    throw err;
  }
}
