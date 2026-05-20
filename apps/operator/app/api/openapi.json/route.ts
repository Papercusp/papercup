/**
 * GET /api/openapi.json
 *
 * Runtime-assembled OpenAPI 3.1 document for the projected-tool surface.
 * Walks the live projection registry (`listAllProjectedTools()`) and
 * emits one path per tool — same data the build-time
 * `apps/operator/scripts/openapi-build.mjs` artifact carries, but
 * always fresh.
 *
 * Phase 7 step 3 (openapi-design-spike-2026-05-20.md §6 Q4 — "both,
 * runtime endpoint canonical").
 *
 * The side-effect import of the agent-tools barrel registers every
 * operator-side first-party tool into the projection registry; without
 * it a cold route would see an empty catalog. Same pattern the
 * operator-scan route uses.
 */
import { NextResponse } from 'next/server';
import { assembleOpenApiDocument } from '@papercusp/agent-mcp';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { allRouteFragments } from '@/lib/endpoint-route';
import '@/lib/agent-tools/index';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request): NextResponse {
  const tools = listAllProjectedTools();
  // Advertise the server the request actually arrived on so a client
  // that fetched openapi.json can use the `servers` entry verbatim.
  const origin = (() => {
    try {
      return new URL(req.url).origin;
    } catch {
      return null;
    }
  })();
  const doc = assembleOpenApiDocument(tools, {
    title: 'Papercusp API',
    description:
      'The full Papercusp API surface. `defineTool` operations are agent ' +
      'tools (POST, with a typed event channel under text/event-stream). ' +
      '`defineRoute` operations (x-papercusp-projection: route) are HTTP ' +
      'plumbing endpoints — UI data, webhooks, transports.',
    ...(origin ? { servers: [{ url: origin, description: 'this operator' }] } : {}),
    // defineRoute fragments — the endpoint route migration's R3 surface.
    extraFragments: allRouteFragments(),
  });
  return NextResponse.json(doc);
}
