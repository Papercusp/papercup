/**
 * GET /api/harness/search?q=...&kind=features|all&limit=20
 *
 * Cross-harness search over work-items (the feature family). Runs the shared
 * hybrid engine — lexical + embedding legs fused by RRF, under the P-017
 * ranking defaults — rather than the raw substring scan this route used to be.
 *
 * P-018 of semantic-search-fingerprint-coverage-2026-08-03. `auth: 'public'`.
 *
 * ─── WHAT THIS ROUTE USED TO DO, AND WHY BOTH HALVES WERE WRONG ────────────
 * It ran `ILIKE '%q%'` over two corpora and ordered the union by `created_at
 * DESC LIMIT n`. That is not a ranking: a query matching more rows than the
 * limit kept the NEWEST ones and silently dropped the best ones, on an
 * owner-facing surface. Both halves are now resolved, differently:
 *
 *  1. **`kind=messages` is GONE, not migrated.** It scanned per-harness
 *     `harness_<slug>.messages`, which are 243 thin views over ONE table,
 *     `harness_shared.messages_consolidated` — the WORK-ITEM MAIL surface
 *     retired 2026-07-26 (WI-6097). Measured 2026-08-08: 222 rows, last write
 *     2026-06-24, zero in the preceding 30 days. Every SIBLING read path over
 *     that table was retired with it (the sync-resolver entry and its
 *     `table-to-query-names` guard, `handoff-context`, and the `'messages'`
 *     kind of the unified search tool); this route was the one the sweep
 *     missed, and `messages` was its DEFAULT kind. Migrating a retired corpus
 *     onto the engine would have wired new code to a dead surface — so the
 *     right move was to finish the retirement, not to rank it.
 *  2. **`kind=features` is DELEGATED.** `harness_features_consolidated` is a
 *     compat view over `harness_shared.work_items` whose predicate is exactly
 *     `familyOf(kind) === 'feature'`, so `searchWorkItems` covers this corpus
 *     precisely — cross-harness (its `harness` filter is optional), already
 *     floored, already reporting its legs. The per-schema loop is gone with
 *     it: the old code issued 2 serial round-trips per harness schema (200+
 *     per request across 243 of them) to reconstruct what one query answers.
 *
 * ─── READ `legs` BEFORE CONCLUDING "NO MATCH" ──────────────────────────────
 * `legs.degraded: true` means a ranking leg did not contribute (embedder down,
 * embeddings not backfilled). A short list is then a DEGRADED search, not an
 * absence — the exact confusion this plan exists to remove, so the field is
 * returned rather than discarded.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { searchWorkItems } from '../../../work-items';

interface FeatureHit {
  kind: 'feature';
  harness_slug: string | null;
  feature_id: string;
  item_kind: string;
  title: string;
  summary: string;
  status: string;
}

export default defineTool({
  method: 'GET',
  path: '/harness/search',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q || q.length < 2) {
      return Response.json({ error: 'q required (>=2 chars)' }, { status: 400 });
    }
    if (q.length > 200) {
      return Response.json({ error: 'q too long (max 200 chars)' }, { status: 400 });
    }
    const kind = url.searchParams.get('kind') ?? 'features';
    const limitN = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));

    // Answered explicitly rather than by falling through to "unknown kind", so
    // a caller still asking for the retired corpus is told what happened and
    // where the traffic went — instead of reading an empty result as "no
    // matching messages", which is the one wrong conclusion available here.
    if (kind === 'messages') {
      return Response.json(
        {
          error:
            'kind=messages is retired. The work-item mail surface was removed 2026-07-26 (WI-6097) ' +
            'after losing to coord:send; its 222 rows are preserved but frozen (last write ' +
            '2026-06-24). Durable work-item-scoped direction is work_items:comment / ' +
            'work_items:checkpoint; live agent messaging is coord:send.',
        },
        { status: 410 },
      );
    }
    if (kind !== 'features' && kind !== 'all') {
      return Response.json({ error: 'kind must be features|all' }, { status: 400 });
    }

    // No `harness` filter — cross-harness is this route's whole reason to exist,
    // and is what an omitted filter means to the engine.
    const { items, legs, applied } = await searchWorkItems(q, { family: 'feature', limit: limitN });

    const featureHits: FeatureHit[] = items.map((w) => ({
      kind: 'feature',
      harness_slug: w.harness,
      feature_id: w.id,
      item_kind: w.kind,
      title: w.title,
      summary: w.summary,
      status: w.state,
    }));

    return Response.json({ q, kind, limit: limitN, featureHits, legs, applied });
  },
});
