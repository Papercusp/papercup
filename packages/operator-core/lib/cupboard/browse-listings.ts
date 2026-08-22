/**
 * browse-listings — the typed read of the Cupboard storefront's generalized
 * `/listings` surface (kind-aware, migration 004), shared by the agent-callable
 * `cupboard:search` tool (cupboard-agent-tool-coverage-2026-07-14 P-008).
 *
 * The public `GET /api/cupboard/listings` route is an UNTYPED verbatim proxy for
 * the browser; this core is the typed subset an agent needs (kind / q / project /
 * limit / cursor) with a structured result. Best-effort: a transient worker
 * outage or a kind the worker predates degrades to an empty/So-503 result rather
 * than throwing.
 */
import { resolveCupboardBaseUrl } from './base-url';
import type { ListingKind } from './types';

export interface BrowseCupboardListingsInput {
  /** harness | blueprint | plugin | pack | knowledge-pack | template | app | all. */
  kind?: ListingKind | 'all';
  /** Free-text search across the storefront (title/description/etc.). */
  q?: string;
  /** Filter to a project_ref (owner/repo). */
  project?: string;
  /** Page size (default 50). */
  limit?: number;
  /** Opaque pagination cursor from a prior page's next_cursor. */
  cursor?: string;
}

export type BrowseCupboardListingsResult =
  | {
      ok: true;
      listings: Record<string, unknown>[];
      next_cursor?: string;
      total?: number;
      kind_facets?: Partial<Record<ListingKind, number>>;
    }
  | { ok: false; status: number; error: string };

export async function browseCupboardListings(
  input: BrowseCupboardListingsInput,
): Promise<BrowseCupboardListingsResult> {
  const base = resolveCupboardBaseUrl();
  const url = new URL(`${base}/listings`);
  if (input.kind && input.kind !== 'all') url.searchParams.set('kind', input.kind);
  if (input.q) url.searchParams.set('q', input.q);
  if (input.project) url.searchParams.set('project', input.project);
  url.searchParams.set('limit', String(input.limit ?? 50));
  if (input.cursor) url.searchParams.set('cursor', input.cursor);

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // A worker predating a kind (e.g. 'pack' before its migration) rejects the
      // kind filter with invalid_field:kind — to a browser that's "none of this
      // kind yet", not an error. Mirror the proxy's degradation.
      if (res.status === 400 && input.kind) {
        const err = (await res.json().catch(() => null)) as { error?: string; field?: string } | null;
        if (err?.error === 'invalid_field' && err.field === 'kind') {
          return { ok: true, listings: [] };
        }
      }
      return { ok: false, status: res.status, error: `cupboard_http_${res.status}` };
    }
    const data = (await res.json()) as {
      results?: Record<string, unknown>[];
      harnesses?: Record<string, unknown>[];
      listings?: Record<string, unknown>[];
      next_cursor?: string | null;
      total?: number;
      kind_facets?: Partial<Record<ListingKind, number>>;
    };
    const listings = data.results ?? data.harnesses ?? data.listings ?? [];
    return {
      ok: true,
      listings,
      ...(typeof data.next_cursor === 'string' ? { next_cursor: data.next_cursor } : {}),
      ...(typeof data.total === 'number' && Number.isFinite(data.total) ? { total: data.total } : {}),
      ...(data.kind_facets && typeof data.kind_facets === 'object'
        ? { kind_facets: data.kind_facets }
        : {}),
    };
  } catch (e) {
    return { ok: false, status: 503, error: e instanceof Error ? e.message : String(e) };
  }
}
