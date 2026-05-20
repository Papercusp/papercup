/**
 * REST query endpoint for the harness sync layer — single-query form.
 *
 * Most harness-page traffic now goes through the *batch* sibling
 * (`/api/zero-harness/rest-query-batch`): the sync client collapses a
 * burst of refetches (initial hydration, a 5s poll tick, an SSE
 * invalidate wave) into one POST so it doesn't open ~40 parallel
 * connections against the browser's 6-per-host HTTP/1.1 cap. This
 * single-query route remains for one-off prefetches and any caller that
 * resolves exactly one query.
 *
 * GET /api/zero-harness/rest-query?name=<name>&args=<json>
 *  → { rows, version }
 *
 * `version` is a wall-clock millisecond stamp; clients use it as a
 * freshness marker. Resolution + the shared PG pool live in
 * `lib/zero-harness-resolver`.
 */
import { NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';

import { resolveNamedQuery } from '@/lib/zero-harness-resolver';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const name = u.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'missing name' }, { status: 400 });
  }
  const argsJson = u.searchParams.get('args') ?? '{}';
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return NextResponse.json({ error: 'invalid args (not JSON)' }, { status: 400 });
  }
  // Early-out when the client already gave up (WS-takeover / unmount).
  if (req.signal.aborted) {
    return new Response(null, { status: 499 });
  }
  try {
    const rows = await resolveNamedQuery(name, args);
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    const body = JSON.stringify({ rows, version: String(Date.now()) });
    // Gzip when the client accepts it and the body is large enough to win.
    const acceptsGzip = (req.headers.get('accept-encoding') ?? '').toLowerCase().includes('gzip');
    if (acceptsGzip && body.length >= 1024) {
      return new Response(gzipSync(body), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-encoding': 'gzip',
          'vary': 'accept-encoding',
        },
      });
    }
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return NextResponse.json({ error: msg, name }, { status: 500 });
  }
}
