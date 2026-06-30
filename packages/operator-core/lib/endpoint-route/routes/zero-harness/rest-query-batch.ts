/**
 * POST /api/zero-harness/rest-query-batch — batch of named queries.
 *
 * Positional results. Single failure yields { error } in its slot.
 *
 * Ported from app/api/zero-harness/rest-query-batch/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { resolveNamedQueryV2, NAME_NOT_FOUND } from '../../../sync-resolver';
import { resourceDeltaConfig } from '../../../sync-resolver/resource-delta-config';
import { negotiateRowsDelta } from '@papercusp/tooldef';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeJsonResponse } from '../../../cpu-task-worker';

// P-006: a delta-aware client adds `delta: <cursor>` ('' to opt in cold) per query; absent →
// today's {rows, version} slot (byte-identical). Inert until the client opts in.
interface BatchQuery { name: string; args?: unknown; delta?: string }

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
          const dcfg = q.delta !== undefined ? resourceDeltaConfig(q.name) : undefined;
          if (dcfg && Array.isArray(v2)) {
            const field = dcfg.itemKeyField;
            const neg = negotiateRowsDelta({
              cursor: q.delta || undefined,
              rows: v2,
              itemKey: (r) => String((r as Record<string, unknown>)[field]),
              itemKeyField: field,
              schemaVersion: dcfg.schemaVersion,
            });
            const meta = { mode: neg.mode, cursor: neg.cursor, checksum: neg.checksum, itemKeyField: neg.itemKeyField };
            return neg.mode === 'delta'
              ? { changes: neg.changes, version, delta: meta }
              : { rows: neg.rows, version, delta: meta };
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

    // Defense-in-depth (data-sync-push-completion D-010): a resolver row may carry a
    // BigInt — a bigserial({ mode: 'bigint' }) PK is ~35 tables — which plain
    // JSON.stringify THROWS on ("Do not know how to serialize a BigInt") → a 500 for the
    // WHOLE batch (a sparse-table 500 that hid in userActions for ages). Resolvers SHOULD
    // return clean rows (sync-resolver's jsonSafeRows), but this boundary replacer is the
    // net so no present/future resolver can 500 the sync transport on a stray BigInt.
    //
    // infra-perf-reliability-audit-round3 P-011 / round4 P-002: offload
    // JSON.stringify + gzip to the cpu-task worker so neither blocks the main
    // event loop. serializeJsonResponse applies the BigInt→Number replacer on
    // the worker thread (byte-identical to the previous inline replacer).
    const acceptsGzip = (req.headers.get('accept-encoding') ?? '').toLowerCase().includes('gzip');
    const { body: responseBody, encoding } = await serializeJsonResponse({ results }, acceptsGzip, list.length);
    if (encoding === 'gzip') {
      return new Response(responseBody, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-encoding': 'gzip',
          'vary': 'accept-encoding',
        },
      });
    }
    return new Response(responseBody as string, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },
});
