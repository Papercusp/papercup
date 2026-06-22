/**
 * _bulk.ts — the ONE keyed-array bulk I/O contract for agent-facing tools
 * (bulk-endpoint-standardization-2026-06-21, D-001).
 *
 * Lives in `@papercusp/agent-mcp` (the lowest package both the operator-core
 * tools AND the agent-mcp read-side tools — artifacts/features — can import; the
 * dep direction is operator-core → agent-mcp → tooldef, so agent-mcp tools cannot
 * reach a helper that lives up in operator-core). `operator-core/lib/agent-tools/
 * _bulk.ts` re-exports this so its ~64 existing relative importers are unchanged.
 *
 * Every bulk tool follows the SAME shape so an agent learns it once and never
 * mis-correlates a result with its input:
 *
 *   INPUT   accepts a scalar OR an array on the logical id field, so a single
 *           call is just n=1 of the bulk call (`id:"X"` ≡ `ids:["X"]`). Use
 *           `mergeIds(args.id, args.ids)` for the id list; heterogeneous
 *           per-item fields ride `items:[{ id, ...fields }]`.
 *   OUTPUT  `{ ok:true, results:[{ ok, <key>, …|error }], counts:{ ok, failed } }`.
 *           Each result SELF-DESCRIBES its correlation key (id/slug) — the agent
 *           reads the key, NEVER the array index. This is robust to reordering,
 *           partial failure, and result-truncation in a way positional
 *           (`result[i] ↔ input[i]`) results are not — LLMs mis-count indices.
 *   FAILURE one bad item NEVER throws: a thrown error (or a returned
 *           `{ ok:false }`) becomes that item's result; top-level `ok:true`
 *           means "the batch ran", `counts.failed` tells the truth.
 *
 * Why an array-of-records and not a keyed map `{ "WI-1": res }`: models emit
 * arrays of uniform records far more reliably than dynamic-key objects, the
 * record can carry per-item `{ ok, error }` cleanly, and it matches the existing
 * house tools (work_items:batch, create_batch, docs:get, fleet:place_batch).
 *
 * This is the single implementation every bulk verb routes through — reuse it,
 * do NOT re-hand-roll the loop + envelope in each tool.
 */
import { z } from 'zod';

/** A Zod schema that accepts a scalar `item` OR an array of them; normalize the
 *  parsed value with `toList`. (The n=1 ergonomic seam for tools that take a
 *  single logical id field rather than `items`.) */
export function scalarOrArray<T extends z.ZodTypeAny>(item: T) {
  return z.union([item, z.array(item)]);
}

/** Normalize a scalar | array | nullish into a flat list. */
export function toList<T>(v: T | readonly T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? [...v] : [v as T];
}

/**
 * Merge a `single` scalar field and a `many` array field into one id list,
 * dedup-preserving order. The n=1 ergonomic seam: a read tool exposes BOTH `id`
 * and `ids`, and callers use whichever reads naturally (`id:"X"` for one,
 * `ids:[…]` for many) — there is one endpoint, the single call is just n=1.
 */
export function mergeIds(single: string | undefined, many: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...(single ? [single] : []), ...(many ?? [])]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export interface BulkItemResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface BulkEnvelope<R extends BulkItemResult = BulkItemResult> {
  ok: true;
  results: R[];
  counts: { ok: number; failed: number };
}

/**
 * Run an async per-item `op` over `items` SEQUENTIALLY, collecting one result
 * per item and NEVER throwing on a single failure. `op` returns the
 * self-describing result (it embeds the item's key). A thrown error becomes
 * `{ ok:false, ...keyOf(item), error }` so even a crash self-describes its key.
 * Returns the house envelope `{ ok, results, counts }`.
 *
 * Sequential by design — matches work_items:batch and avoids hammering the PG
 * pool. Result order follows input order as a convenience; the CONTRACT is the
 * embedded key, not the index.
 */
export async function runBulk<I, R extends BulkItemResult>(
  items: readonly I[],
  op: (item: I, index: number) => Promise<R>,
  opts?: { keyOf?: (item: I, index: number) => Record<string, unknown> },
): Promise<BulkEnvelope<R>> {
  const results: R[] = [];
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += 1) {
    let r: R;
    try {
      r = await op(items[i], i);
    } catch (e) {
      r = {
        ok: false,
        ...(opts?.keyOf ? opts.keyOf(items[i], i) : {}),
        error: e instanceof Error ? e.message : String(e),
      } as R;
    }
    if (r.ok) ok += 1;
    else failed += 1;
    results.push(r);
  }
  return { ok: true, results, counts: { ok, failed } };
}

/**
 * Wrap a bulk envelope (or any JSON payload) in the framework's NATIVE canonical
 * `ToolResponse` shape `{ data }` — the SAME shape a `defineTool` handler returns
 * to opt into format-aware serialization.
 *
 * Token optimization (definetool-token-optimization-adoption P-006, completing
 * P-001/D-008): the framework dispatch serializes `data` through the SINGLE
 * `serializeToolResponse` path (`tooldef/serialize-result.ts`) — on the
 * agent-facing MCP transport it auto-re-encodes an object-with-an-array-field
 * (every bulk envelope `{ ok, results:[…], counts }` is) to TOON (lossless,
 * ~18-38% smaller, with the D-005 size-guard keeping a heterogeneous envelope on
 * JSON when TOON would be larger); every other transport (in-process / HTTP / IPC)
 * stays lossless JSON. This is the EXACT same token behavior the old raw-`{content}`
 * shape got via the `reencodableJsonPayload` re-encode shim (P-002) — but emitting
 * `{ data }` directly means bulk results no longer ride the raw-ToolResult bypass,
 * so a `{data}`/output-schema lint can see them (P-003) and there is one canonical
 * return shape across all bulk tools.
 */
export function bulkContent(payload: unknown) {
  return { data: payload };
}
