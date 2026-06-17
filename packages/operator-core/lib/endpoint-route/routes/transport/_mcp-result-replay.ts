/**
 * MCP write idempotency / result replay (full-app-audit P-046 / EI-68).
 *
 * The problem: an MCP client that disconnects mid-call loses the result
 * FOREVER. The tool often already executed (the write committed); the
 * response then dies on the closed stream (hono-host swallows that
 * ERR_INVALID_STATE class by design — one disconnect must not crash the
 * host). The reconnecting caller cannot distinguish "ran, result
 * dropped" from "never ran" — so it either re-fires a write (double
 * execution) or gives up on a write that actually landed.
 *
 * The contract (opt-in, per call): pass `_meta.idempotencyKey` (any
 * caller-chosen string ≤200 chars, unique per logical write) on
 * tools/call. The transport then:
 *
 *   1. BEFORE executing — looks the key up here. A hit returns the
 *      stored result verbatim, tagged `_meta.replayed: true`, WITHOUT
 *      re-executing the tool.
 *   2. AFTER executing — persists the serialized result under the key,
 *      best-effort (a store failure never fails the call).
 *
 * Keys are scoped per caller (`ownerKey` = the stable session identity:
 * uiClientId for SU/power sessions, spawnId for signed spawns), so two
 * agents can use the same key string without collision.
 *
 * Storage: harness_shared.mcp_tool_results (mig 220), admin handle —
 * infra data, sweep-bounded (rows older than REPLAY_TTL are deleted
 * opportunistically on write, at most once a minute per process).
 *
 * Known limit (documented, accepted): the lookup→execute→store sequence
 * is not a distributed claim — two CONCURRENT calls with the same key
 * can both execute. The reconnect flow this exists for is sequential
 * (call → connection dies → re-call), where the window cannot occur.
 */

import { getOrgPg } from '@papercusp/db-org';

/** Stored/replayed result — the serialized MCP tools/call result shape. */
export interface StoredMcpResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

/** Replay rows older than this are dead — the caller has long moved on. */
const REPLAY_TTL_MS = 60 * 60 * 1000;
/** Opportunistic sweep at most this often per process. */
const SWEEP_MIN_INTERVAL_MS = 60 * 1000;
let lastSweepAt = 0;

const KEY_MAX = 200;

/**
 * Above this many bytes of serialized result we SKIP persisting the replay row
 * (operator-scalability-event-loop P1-2 / app-wide-load-traps F-A1 "stacked
 * 4th stringify"). The store is a synchronous payload-sized `JSON.stringify` on
 * the serving event loop; for a large result that blocks long enough to drop
 * the very MCP/SSE connections this buffer exists to make resilient. The buffer
 * is opt-in and exists for WRITE idempotency — those results are small
 * confirmation payloads (`{ ok, created: 'WI-42' }`), comfortably under the
 * gate. A pathologically large result is exactly the one we must not block on;
 * skipping its row only forgoes replay for a write whose result was huge, while
 * the write itself still committed. Best-effort by contract, so a skip is safe.
 */
const REPLAY_STORE_MAX_BYTES = 256 * 1024;

/** Validate a caller-supplied idempotency key — non-empty string, bounded. */
export function validIdempotencyKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const k = v.trim();
  if (k.length === 0 || k.length > KEY_MAX) return null;
  return k;
}

export async function lookupStoredMcpResult(
  ownerKey: string,
  idempotencyKey: string,
): Promise<StoredMcpResult | null> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ result: unknown; is_error: boolean }>>`
    SELECT result, is_error
      FROM harness_shared.mcp_tool_results
     WHERE owner_key = ${ownerKey} AND idempotency_key = ${idempotencyKey}
       AND created_at > now() - make_interval(secs => ${REPLAY_TTL_MS / 1000})
  `;
  const row = rows[0];
  if (!row) return null;
  const stored = row.result as StoredMcpResult;
  return {
    ...stored,
    ...(row.is_error ? { isError: true } : {}),
    // Tag the replay so the caller KNOWS this is the stored outcome of a
    // prior execution, not a fresh run.
    _meta: { ...(stored._meta ?? {}), replayed: true },
  };
}

function serializeStoredMcpResult(result: StoredMcpResult): string {
  const contentParts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item && typeof item === 'object') {
        const typed = item as Record<string, unknown>;
        if (typed.type === 'text' && typeof typed.text === 'string') {
          contentParts.push(`{"type":"text","text":${typed.text}}`);
        } else {
          contentParts.push(JSON.stringify(item));
        }
      }
    }
  }
  let json = `{"content":[${contentParts.join(',')}]}`;
  if (result.isError) json += ',"isError":true';
  if (result._meta) json += `,"_meta":${JSON.stringify(result._meta)}`;
  return json;
}

export async function storeMcpResult(args: {
  ownerKey: string;
  idempotencyKey: string;
  toolName: string;
  workspaceId: string;
  result: StoredMcpResult;
}): Promise<void> {
  const { sql } = getOrgPg();
  // Size gate: skip storing pathologically large results (operator-scalability P1-2
  // / app-wide-load-traps F-A1). The store is synchronous on the event loop; large
  // results block long enough to drop MCP/SSE connections. Estimate size BEFORE
  // stringify to avoid the expensive JSON.stringify call on large content — reuse
  // the already-serialized text in content.text fields. Skipping the row forgoes
  // replay for that ONE huge result while the write itself still committed — best-
  // effort by contract, safe.
  let estimatedSize = 200; // baseline for metadata (_meta, isError, wrapper)
  if (Array.isArray(args.result.content)) {
    for (const item of args.result.content) {
      if (item && typeof item === 'object') {
        // Content items are {type: 'text', text: <serialized>}. Reuse the text
        // length instead of re-serializing it.
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string') {
          estimatedSize += text.length;
        }
      }
    }
  }
  if (estimatedSize > REPLAY_STORE_MAX_BYTES) {
    maybeSweep();
    return;
  }
  // jsonb bound as text::jsonb — the operator's postgres-js client throws
  // on bare-object jsonb params (agent-insights/postgres-js-jsonb-binding).
  // Reuse already-serialized text in content items to avoid the 4th stringify
  // (operator P1-4 / app-wide-load-traps F-A1-part2): build the JSON manually
  // from components instead of calling JSON.stringify on the whole result.
  const resultJson = serializeStoredMcpResult(args.result);
  // First write wins: if a concurrent same-key call already stored, keep
  // the original (both executed in that pathological case; the FIRST
  // stored result is the one every later replay sees — stable).
  await sql`
    INSERT INTO harness_shared.mcp_tool_results
      (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
    VALUES
      (${args.ownerKey}, ${args.idempotencyKey}, ${args.toolName},
       ${args.workspaceId}, ${resultJson}::text::jsonb, ${args.result.isError === true})
    ON CONFLICT (owner_key, idempotency_key) DO NOTHING
  `;
  maybeSweep();
}

export async function sweepExpiredMcpResults(now = Date.now()): Promise<number> {
  const { sql } = getOrgPg();
  // ISO-string param, not a Date — this pool's serializer config rejects
  // Date instances (same constraint as the jsonb ::text::jsonb binding).
  const cutoff = new Date(now - REPLAY_TTL_MS).toISOString();
  const rows = await sql<Array<{ n: number }>>`
    WITH del AS (
      DELETE FROM harness_shared.mcp_tool_results
       WHERE created_at < ${cutoff}::timestamptz
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM del
  `;
  return Number(rows[0]?.n ?? 0);
}

function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepExpiredMcpResults(now).catch(() => {
    /* best-effort janitor */
  });
}
