/**
 * POST /api/zero-harness/rest-query-batch — batch of named queries.
 *
 * Positional results. Single failure yields { error } in its slot.
 *
 * Ported from app/api/zero-harness/rest-query-batch/route.ts. `auth: 'public'`.
 */
import { gzipSync } from 'node:zlib';
import { resolveNamedQueryV2, NAME_NOT_FOUND } from '../../../sync-resolver';
import { defineTool } from '@papercusp/agent-mcp';

interface BatchQuery { name: string; args?: unknown }

export default defineTool({
  method: 'POST',
  path: '/zero-harness/rest-query-batch',
  auth: 'loopback',
  // Pure sync-transport, polled ~every 3s — exempt from route_invocations
  // telemetry so the table doesn't flood (plan Q7: sampleRate 0 for pure
  // sync transports).
  sampleRate: 0,
  async handler(req) {
    let body: { queries?: BatchQuery[] };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid body (not JSON)' }, { status: 400 });
    }
    const list = body?.queries;
    if (!Array.isArray(list) || list.length === 0) {
      return Response.json({ error: 'body.queries must be a non-empty array' }, { status: 400 });
    }
    if (list.length > 200) {
      return Response.json({ error: 'batch too large (max 200)' }, { status: 400 });
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
          // P-022 cutover (2026-05-25): legacy fall-through removed.
          // NAME_NOT_FOUND in batch context returns an error per-slot
          // rather than the legacy resolver path.
          const v2 = await resolveNamedQueryV2(q.name, q.args ?? {});
          if (v2 === NAME_NOT_FOUND) {
            return { error: `unknown queryName: ${q.name}` };
          }
          return { rows: v2, version };
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
  },
});
