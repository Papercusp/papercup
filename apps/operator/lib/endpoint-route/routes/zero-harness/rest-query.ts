/**
 * GET /api/zero-harness/rest-query?name=...&args=<json>
 *
 * Single-query REST endpoint with gzip when accepted.
 *
 * Ported from app/api/zero-harness/rest-query/route.ts. `auth: 'public'`.
 */
import { gzipSync } from 'node:zlib';
import { resolveNamedQuery } from '@/lib/zero-harness-resolver';
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'GET',
  path: '/zero-harness/rest-query',
  auth: 'public',
  // Pure sync-transport, polled ~every 3s — exempt from route_invocations
  // telemetry so the table doesn't flood (plan Q7: sampleRate 0 for pure
  // sync transports).
  sampleRate: 0,
  async handler(req) {
    const u = new URL(req.url);
    const name = u.searchParams.get('name');
    if (!name) {
      return Response.json({ error: 'missing name' }, { status: 400 });
    }
    const argsJson = u.searchParams.get('args') ?? '{}';
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return Response.json({ error: 'invalid args (not JSON)' }, { status: 400 });
    }
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    try {
      const rows = await resolveNamedQuery(name, args);
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      const body = JSON.stringify({ rows, version: String(Date.now()) });
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
      return Response.json({ error: msg, name }, { status: 500 });
    }
  },
});
