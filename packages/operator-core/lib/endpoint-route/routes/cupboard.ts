/**
 * Cupboard proxy routes (Phase 9 P-052 browse + D-002 operator moderation).
 *
 * Thin proxy from the operator to the external Cupboard server.
 * URL resolved from NEXT_PUBLIC_CUPBOARD_URL env (falls back to
 * PAPERCUSP_CUPBOARD_URL). When unset, returns empty list / 503.
 *
 *   GET  /api/cupboard/listings                      — list + search (public)
 *   GET  /api/cupboard/listings/:id                  — detail (public)
 *   GET  /api/cupboard/tools                         — tool discovery (local pack
 *        catalog merged with Cupboard provides_tools; tool-distribution P-006)
 *   GET  /api/cupboard/admin/reports                 — operator: list reports
 *   POST /api/cupboard/admin/reports/:id/resolve     — operator: resolve a report
 *   POST /api/cupboard/admin/harnesses/:id/unlist    — operator: takedown
 *
 * The /admin/* routes add the maintainer's gh-token server-side (the browser
 * never holds it), exactly like the publish proxy — the Cupboard worker then
 * gates on its CUPBOARD_OPERATOR_GITHUB_IDS allowlist.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getGhAuthToken } from '../../identity/gh-token';
import { resolveCupboardBaseUrl } from './harness/cupboard-publish';
import { derivePackCatalog } from '../../cupboard/pack-catalog';
import {
  buildToolsDiscovery,
  buildToolProvenance,
  collectToolMeta,
} from '../../cupboard/tools-discovery';
import { getPluginHost } from '../../plugin-host-runtime';

// Base URL for the external Cupboard worker. Single source of truth is
// resolveCupboardBaseUrl() (PAPERCUSP_CUPBOARD_URL or the canonical default) —
// the same resolver the publish + admin proxies use. NOTE: the systemd dev unit
// sources .env.local, NOT ~/.papercusp/env, so reading process.env directly here
// (the old behavior) yielded an empty URL and a silently-empty listing
// (`cupboard_url_missing`); the resolver's hardcoded default fixes that.

// ─── GET /cupboard/listings ───────────────────────────────────────

const listCupboardListings = defineTool({
  method: 'GET',
  path: '/cupboard/listings',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    // The Cupboard worker serves the generalized /listings surface (kind-aware,
    // migration 004) and returns { results, next_cursor }. We forward all query
    // params verbatim — incl. `kind` (harness|blueprint|snapshot|plugin|all) and
    // `project` (project_ref) — plus q / claim / cursor / limit.
    const base = resolveCupboardBaseUrl();
    const upstream = new URL(`${base}/listings`);
    url.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

    try {
      let res = await fetch(upstream.toString(), {
        headers: { 'User-Agent': 'papercusp-operator/1' },
        signal: AbortSignal.timeout(10_000),
      });
      // Transitional: a worker not yet on migration 004 has no /listings — fall
      // back to /harnesses (harness-kind only). Self-heals once the worker ships
      // /listings; until then, non-harness kinds simply return empty (none exist
      // on the old worker anyway).
      if (res.status === 404) {
        const fallback = new URL(`${base}/harnesses`);
        url.searchParams.forEach((v, k) => {
          if (k !== 'kind' && k !== 'project') fallback.searchParams.set(k, v);
        });
        res = await fetch(fallback.toString(), {
          headers: { 'User-Agent': 'papercusp-operator/1' },
          signal: AbortSignal.timeout(10_000),
        });
      }
      if (!res.ok) {
        // Transitional: a worker predating a kind (e.g. 'pack' before its
        // migration 006) rejects the kind filter with invalid_field:kind. To
        // the browser that's "no listings of this kind yet", not an error —
        // same degradation fetchCupboardUnits applies for the pack catalog.
        if (res.status === 400 && url.searchParams.get('kind')) {
          const err = (await res.json().catch(() => null)) as { error?: string; field?: string } | null;
          if (err?.error === 'invalid_field' && err.field === 'kind') {
            return Response.json({ listings: [] });
          }
        }
        return Response.json(
          { error: `cupboard: HTTP ${res.status}` },
          { status: res.status },
        );
      }
      const data = await res.json();
      // Worker shape is { results: [...] }; tolerate legacy { harnesses }/{ listings }.
      const listings = data?.results ?? data?.harnesses ?? data?.listings ?? [];
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
    const base = resolveCupboardBaseUrl();
    try {
      let res = await fetch(`${base}/listings/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': 'papercusp-operator/1' },
        signal: AbortSignal.timeout(10_000),
      });
      // Transitional fallback for a pre-migration-004 worker (see list handler).
      if (res.status === 404) {
        res = await fetch(`${base}/harnesses/${encodeURIComponent(id)}`, {
          headers: { 'User-Agent': 'papercusp-operator/1' },
          signal: AbortSignal.timeout(10_000),
        });
      }
      if (!res.ok) {
        return Response.json({ error: `cupboard: HTTP ${res.status}` }, { status: res.status });
      }
      const data = await res.json();
      // Worker returns the bare listing row; tolerate { harness }/{ listing } wrappers.
      const listing = data?.harness ?? data?.listing ?? data;
      return Response.json({ listing });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

// ─── GET /cupboard/tools ─────────────────────────────────────────
// The marketplace's Tools discovery section (tool-distribution-granularity
// P-006/D-005 + tool-distribution-discovery P-005/P-007): every known tool
// resolved to its provider — the merged local pack catalog (built-ins +
// installed plugins/packs) plus the Cupboard's provides_tools declarations.
// NOT a proxy: the local registries are half the answer, so this derives the
// catalog in-process and folds the Cupboard in. `q` runs capability search
// (relevance-ranked over name/category/capability/provider/description);
// `category` + `status` narrow; `categories` facets ride back for the UI.

const listCupboardTools = defineTool({
  method: 'GET',
  path: '/cupboard/tools',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? undefined;
    const category = url.searchParams.get('category') ?? undefined;
    const statusRaw = url.searchParams.get('status');
    const status =
      statusRaw === 'available' || statusRaw === 'installable' ? statusRaw : undefined;
    if (statusRaw != null && statusRaw !== '' && !status) {
      return Response.json({ error: 'invalid_field', field: 'status' }, { status: 400 });
    }
    try {
      // The projected-tool registry only carries plugin tools once the plugin
      // host has loaded them (lazy on first use) — warm it so a cold operator's
      // first discovery call doesn't under-report installed units.
      await getPluginHost();
      const cat = await derivePackCatalog({ timeoutMs: 8_000 });
      const meta = collectToolMeta();
      return Response.json(buildToolsDiscovery(cat, { q, status, category }, meta));
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

// ─── GET /cupboard/provides ──────────────────────────────────────
// "What provides X" — the human-facing inverse of the dependency resolver
// (tool-distribution-discovery P-006). Given a tool name (`?tool=`, exact) or
// a capability phrase (`?q=`), return the providing pack/plugin/listing +
// install action. An installable match carries `provider.listingId` + `unit`,
// which the UI routes to the listing's install-consent flow (D-005) — the same
// surface the dep gate's `cupboard:install-deps` acts on.

const resolveCupboardProvides = defineTool({
  method: 'GET',
  path: '/cupboard/provides',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const tool = url.searchParams.get('tool')?.trim() || undefined;
    const q = url.searchParams.get('q')?.trim() || undefined;
    if (!tool && !q) {
      return Response.json(
        { error: 'missing_query', detail: 'pass ?tool=<name> or ?q=<capability>' },
        { status: 400 },
      );
    }
    try {
      await getPluginHost();
      const cat = await derivePackCatalog({ timeoutMs: 8_000 });
      const meta = collectToolMeta();
      return Response.json(buildToolProvenance(cat, { tool, q }, meta));
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 503 });
    }
  },
});

// ─── Operator moderation proxy (/cupboard/admin/*) ───────────────────
// Adds the maintainer's gh-token server-side (browser never holds it), like
// the publish proxy; the Cupboard worker enforces the operator allowlist.

async function forwardToCupboardAdmin(
  pathAndQuery: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<Response> {
  const tokenRes = await getGhAuthToken();
  if (tokenRes.kind !== 'ok') {
    return Response.json({ error: 'gh_auth_required', detail: tokenRes.error.kind }, { status: 401 });
  }
  const url = `${resolveCupboardBaseUrl()}${pathAndQuery}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${tokenRes.token}`,
        'User-Agent': 'papercusp-operator-cupboard-proxy',
        ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return Response.json(
      { error: 'cupboard_unreachable', detail: (e as Error).message.slice(0, 200) },
      { status: 502 },
    );
  }
  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json(
      { error: 'cupboard_bad_response', detail: text.slice(0, 200), upstream_status: upstream.status },
      { status: 502 },
    );
  }
  return Response.json(parsed, { status: upstream.status });
}

const listCupboardReports = defineTool({
  method: 'GET',
  path: '/cupboard/admin/reports',
  auth: 'public',
  async handler(req) {
    const status = new URL(req.url).searchParams.get('status');
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return forwardToCupboardAdmin(`/admin/reports${qs}`, { method: 'GET' });
  },
});

const resolveCupboardReport = defineTool({
  method: 'POST',
  path: '/cupboard/admin/reports/:id/resolve',
  auth: 'public',
  async handler(req, ctx) {
    const id = ctx.params.id as string;
    const body = await req.text();
    return forwardToCupboardAdmin(`/admin/reports/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: body || '{}',
    });
  },
});

const unlistCupboardHarness = defineTool({
  method: 'POST',
  path: '/cupboard/admin/harnesses/:id/unlist',
  auth: 'public',
  async handler(req, ctx) {
    const id = ctx.params.id as string;
    const body = await req.text();
    return forwardToCupboardAdmin(`/admin/harnesses/${encodeURIComponent(id)}/unlist`, {
      method: 'POST',
      body: body || '{}',
    });
  },
});

export default [
  listCupboardListings,
  getCupboardListing,
  listCupboardTools,
  resolveCupboardProvides,
  listCupboardReports,
  resolveCupboardReport,
  unlistCupboardHarness,
];
