/**
 * GET /api/zero-harness/rest-query?name=...&args=<json>
 *
 * Single-query REST endpoint with gzip when accepted.
 *
 * Ported from app/api/zero-harness/rest-query/route.ts. `auth: 'public'`.
 */
import { resolveNamedQueryV2, NAME_NOT_FOUND } from '../../../sync-resolver';
import { resourceDeltaConfig } from '../../../sync-resolver/resource-delta-config';
import { negotiateRowsDelta } from '@papercusp/tooldef';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeJsonResponse } from '../../../cpu-task-worker';

export default defineTool({
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
      // P-022 cutover (2026-05-25): all 53 live queryNames are in the
      // v2 dispatcher; the legacy ZQL resolver fall-through has been
      // removed. NAME_NOT_FOUND now surfaces as 400 instead of falling
      // through to a Zero compilation that no longer exists.
      const v2 = await resolveNamedQueryV2(name, args);
      if (v2 === NAME_NOT_FOUND) {
        return Response.json(
          { error: `unknown queryName: ${name}`, name },
          { status: 400 },
        );
      }
      const rows = v2;
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      // P-006 (the ~327GB sync win): rows-delta for a DELTA-AWARE client — one that sent
      // `&delta=<cursor>` (or `&delta=` cold to opt in). Absent → today's exact full path,
      // byte-identical; a resource with no delta config also serves full. The full-view
      // checksum lets the client verify its merge + refetch on any mismatch, so a wrong/stale
      // key can only cost a refetch (no win), never a wrong view. Inert until a client opts in.
      //
      // infra-perf-reliability-audit-round3 P-011 / round4 P-002: offload
      // JSON.stringify + gzip to the cpu-task worker so neither blocks the main
      // event loop. serializeJsonResponse handles the BigInt replacer on the worker.
      const deltaParam = u.searchParams.get('delta');
      const dcfg = deltaParam !== null ? resourceDeltaConfig(name) : undefined;
      const acceptsGzip = (req.headers.get('accept-encoding') ?? '').toLowerCase().includes('gzip');
      let responseValue: unknown;
      let itemCount: number;
      if (dcfg && Array.isArray(rows)) {
        const field = dcfg.itemKeyField;
        const neg = negotiateRowsDelta({
          cursor: deltaParam || undefined,
          rows,
          itemKey: (r) => String((r as Record<string, unknown>)[field]),
          itemKeyField: field,
          schemaVersion: dcfg.schemaVersion,
        });
        const meta = { mode: neg.mode, cursor: neg.cursor, checksum: neg.checksum, itemKeyField: neg.itemKeyField };
        if (neg.mode === 'delta') {
          responseValue = { changes: neg.changes, version: String(Date.now()), delta: meta };
          itemCount = neg.changes?.length ?? 0;
        } else {
          responseValue = { rows: neg.rows, version: String(Date.now()), delta: meta };
          itemCount = neg.rows?.length ?? 0;
        }
      } else {
        responseValue = { rows, version: String(Date.now()) };
        itemCount = Array.isArray(rows) ? rows.length : 1;
      }
      const { body, encoding } = await serializeJsonResponse(responseValue, acceptsGzip, itemCount);
      if (encoding === 'gzip') {
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-encoding': 'gzip',
            'vary': 'accept-encoding',
          },
        });
      }
      return new Response(body as string, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      return Response.json({ error: msg, name }, { status: 500 });
    }
  },
});
