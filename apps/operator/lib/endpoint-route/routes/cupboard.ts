/**
 * Cupboard proxy routes (Phase 9 P-052).
 *
 * Thin proxy from the operator to the external Cupboard server.
 * URL resolved from NEXT_PUBLIC_CUPBOARD_URL env (falls back to
 * PAPERCUSP_CUPBOARD_URL). When unset, returns empty list / 503.
 *
 *   GET  /api/cupboard/listings          — list + search
 *   GET  /api/cupboard/listings/:id      — detail
 */

import { defineTool } from '@papercusp/agent-mcp';

const CUPBOARD_URL =
  process.env.NEXT_PUBLIC_CUPBOARD_URL ??
  process.env.PAPERCUSP_CUPBOARD_URL ??
  '';

// ─── GET /cupboard/listings ───────────────────────────────────────

const listCupboardListings = defineTool({
  method: 'GET',
  path: '/cupboard/listings',
  auth: 'public',
  async handler(req) {
    if (!CUPBOARD_URL) {
      return Response.json({ listings: [], cupboard_url_missing: true });
    }

    const url = new URL(req.url);
    const upstream = new URL(`${CUPBOARD_URL}/api/harnesses`);
    // Forward query params (q, claim_status, cursor, limit).
    url.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

    try {
      const res = await fetch(upstream.toString(), {
        headers: { 'User-Agent': 'papercusp-operator/1' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return Response.json(
          { error: `cupboard: HTTP ${res.status}` },
          { status: res.status },
        );
      }
      const data = await res.json();
      // The upstream returns { harnesses: [...] }; map to { listings: [...] }.
      const listings = Array.isArray(data?.harnesses) ? data.harnesses : (data?.listings ?? []);
      return Response.json({ listings });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

// ─── GET /cupboard/listings/:id ──────────────────────────────────

const getCupboardListing = defineTool({
  method: 'GET',
  path: '/cupboard/listings/:id',
  auth: 'public',
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    if (!CUPBOARD_URL) {
      return Response.json({ error: 'Cupboard URL not configured' }, { status: 503 });
    }

    try {
      const res = await fetch(`${CUPBOARD_URL}/api/harnesses/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': 'papercusp-operator/1' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return Response.json({ error: `cupboard: HTTP ${res.status}` }, { status: res.status });
      }
      const data = await res.json();
      const listing = data?.harness ?? data?.listing ?? data;
      return Response.json({ listing });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

export default [listCupboardListings, getCupboardListing];
