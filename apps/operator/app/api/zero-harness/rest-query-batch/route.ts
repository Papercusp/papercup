/**
 * Batched REST query endpoint for the harness sync layer.
 *
 * Why this exists: the harness dashboard registers ~40 distinct sync
 * queries. When they refetch together — initial hydration, a 5s poll
 * tick, or an SSE `invalidate` wave from the running orchestrator's DB
 * churn — the single-query route would open ~40 parallel connections.
 * Browsers cap HTTP/1.1 at 6 connections per host, so the surplus queues
 * for 10s+ and starves every other request on the page, including the
 * on-demand EventSource behind the live agent-thinking popover (it would
 * sit in "connecting…" until a slot freed).
 *
 * Batching collapses a whole refetch wave into ONE request, so the
 * connection pool stays free.
 *
 * POST /api/zero-harness/rest-query-batch
 *   body: { queries: [ { name, args }, ... ] }
 *    →    { results: [ { rows, version } | { error }, ... ] }
 *
 * Results are positional — `results[i]` corresponds to `queries[i]`. A
 * single query failing yields `{ error }` in its slot; it does not fail
 * the whole batch.
 */
import { NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';

import { resolveNamedQuery } from '@/lib/zero-harness-resolver';

interface BatchQuery { name: string; args?: unknown }

export async function POST(req: Request) {
  let body: { queries?: BatchQuery[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body (not JSON)' }, { status: 400 });
  }
  const list = body?.queries;
  if (!Array.isArray(list) || list.length === 0) {
    return NextResponse.json({ error: 'body.queries must be a non-empty array' }, { status: 400 });
  }
  if (list.length > 200) {
    return NextResponse.json({ error: 'batch too large (max 200)' }, { status: 400 });
  }
  if (req.signal.aborted) {
    return new Response(null, { status: 499 });
  }

  const version = String(Date.now());
  const results = await Promise.all(
    list.map(async (q) => {
      if (!q || typeof q.name !== 'string') {
        return { error: 'missing query name' };
      }
      try {
        const rows = await resolveNamedQuery(q.name, q.args ?? {});
        return { rows, version };
      } catch (err: any) {
        return { error: err?.message ?? String(err) };
      }
    }),
  );

  if (req.signal.aborted) {
    return new Response(null, { status: 499 });
  }

  const payload = JSON.stringify({ results });
  const acceptsGzip = (req.headers.get('accept-encoding') ?? '').toLowerCase().includes('gzip');
  if (acceptsGzip && payload.length >= 1024) {
    return new Response(gzipSync(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'vary': 'accept-encoding',
      },
    });
  }
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
