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

import { createHash, randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { ToolResult } from '@papercusp/tooldef';

/**
 * Stored/replayed result — the serialized MCP tools/call result shape.
 *
 * `content` reuses `ToolResult['content']` rather than restating it as
 * `Array<Record<string, unknown>>`. The wider shape looked safer and was not:
 * `decodeStoredMcpResult` already reaches this type through a bare
 * `decoded as StoredMcpResult` cast on parsed JSON, so the widening bought no
 * validation — it only made a stored result UNASSIGNABLE to `ToolResult`.
 *
 * That is load-bearing because a tool handler may legitimately return a
 * replayed result straight out of this store (`harness:generate-from-repo`
 * does). With the wide shape such a handler infers
 * `Promise<StoredMcpResult>`, fails both tool overloads of `defineTool`, and
 * falls through to the ROUTE overload — surfacing as an opaque TS2769 that
 * names `Request`/`RouteContext` and points at `args`, nowhere near the real
 * cause. Keeping the two types structurally identical is what stops that
 * whole class, and a stored MCP result genuinely IS an MCP result.
 */
export interface StoredMcpResult {
  content: ToolResult['content'];
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

/** The marker stored while an idempotent write is executing asynchronously. */
export const PENDING_MCP_RESULT_STATE = 'pending';

export interface PendingMcpResultMarker {
  state: typeof PENDING_MCP_RESULT_STATE;
  tool: string;
  progressId: string;
  ownerKey: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
}

export interface PendingMcpResultClaim {
  claimed: boolean;
  pending: boolean;
  result: StoredMcpResult | null;
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

export const MCP_OVERFLOW_FALLBACK_SCHEME = 'papercusp://result/';
const OVERFLOW_FALLBACK_KEY_PREFIX = 'result-door-overflow:';
const OVERFLOW_FALLBACK_CHUNK_BYTES = 32 * 1024;
export const MCP_OVERFLOW_FALLBACK_MAX_BYTES = 50 * 1024 * 1024;

export interface McpOverflowFallbackReference {
  id: string;
  uri: string;
  byteCount: number;
  sha256: string;
  expiresAt: string;
  ownerId: string;
  audience: 'owner';
  mediaType: 'application/json';
}

interface McpOverflowFallbackManifest {
  schemaVersion: 'papercusp.mcp-overflow-fallback/v1';
  id: string;
  state: 'pending' | 'ready' | 'failed';
  ownerId: string;
  byteCount: number;
  sha256: string;
  chunkBytes: number;
  chunkCount: number;
  expiresAt: string;
  sourceUri?: string;
  sourcePath?: string;
}

export type McpOverflowFallbackPage =
  | { state: 'pending' | 'failed' | 'missing' | 'expired' | 'forbidden' | 'integrity_mismatch' }
  | {
      state: 'ready';
      uri: string;
      page: Buffer;
      byteOffset: number;
      totalBytes: number;
      sha256: string;
      expiresAt: string;
      nextOffset: number | null;
    };

function overflowManifestKey(id: string): string {
  return OVERFLOW_FALLBACK_KEY_PREFIX + id + ':manifest';
}

function overflowChunkKey(id: string, index: number): string {
  return OVERFLOW_FALLBACK_KEY_PREFIX + id + ':chunk:' + index.toString().padStart(6, '0');
}

function overflowSourceKey(source: string): string {
  return OVERFLOW_FALLBACK_KEY_PREFIX + 'source:' + sha256Hex(Buffer.from(source, 'utf8'));
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function objectAt(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function manifestFromResult(value: unknown): McpOverflowFallbackManifest | null {
  const result = objectAt(value);
  const manifest = objectAt(objectAt(result?._meta)?.overflowFallback);
  if (
    manifest?.schemaVersion !== 'papercusp.mcp-overflow-fallback/v1' ||
    typeof manifest.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.id) ||
    !['pending', 'ready', 'failed'].includes(String(manifest.state)) ||
    typeof manifest.ownerId !== 'string' ||
    !Number.isSafeInteger(manifest.byteCount) || Number(manifest.byteCount) < 0 ||
    typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.chunkBytes) || Number(manifest.chunkBytes) <= 0 ||
    !Number.isSafeInteger(manifest.chunkCount) || Number(manifest.chunkCount) < 0 ||
    typeof manifest.expiresAt !== 'string'
  ) return null;
  return manifest as unknown as McpOverflowFallbackManifest;
}

export function mcpOverflowFallbackIdFromUri(uri: string): string | null {
  if (!uri.startsWith(MCP_OVERFLOW_FALLBACK_SCHEME)) return null;
  const id = uri.slice(MCP_OVERFLOW_FALLBACK_SCHEME.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

/** Reserve the owner-scoped URI, then persist the bytes in bounded chunks. */
export async function beginMcpOverflowFallback(args: {
  ownerKey: string;
  ownerId: string;
  workspaceId: string;
  toolName: string;
  payload: Buffer;
  sourceUri?: string;
  sourcePath?: string;
}): Promise<{ reference: McpOverflowFallbackReference; ready: Promise<boolean> }> {
  if (!args.ownerKey || !args.ownerId || !args.workspaceId || args.workspaceId === '*') {
    throw new Error('overflow fallback requires owner and workspace identity');
  }
  if ([args.sourceUri, args.sourcePath].some((source) => source !== undefined && source.length > 4_096)) {
    throw new Error('overflow fallback source alias exceeds its bounded storage limit');
  }
  if (args.payload.byteLength > MCP_OVERFLOW_FALLBACK_MAX_BYTES) {
    throw new Error('overflow fallback payload exceeds its bounded storage limit');
  }
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + REPLAY_TTL_MS).toISOString();
  const manifest: McpOverflowFallbackManifest = {
    schemaVersion: 'papercusp.mcp-overflow-fallback/v1',
    id,
    state: 'pending',
    ownerId: args.ownerId,
    byteCount: args.payload.byteLength,
    sha256: sha256Hex(args.payload),
    chunkBytes: OVERFLOW_FALLBACK_CHUNK_BYTES,
    chunkCount: Math.ceil(args.payload.byteLength / OVERFLOW_FALLBACK_CHUNK_BYTES),
    expiresAt,
    ...(args.sourceUri ? { sourceUri: args.sourceUri } : {}),
    ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
  };
  const { sql } = getOrgPg();
  const pendingJson = serializeStoredMcpResult({ content: [], _meta: { overflowFallback: manifest } });
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.mcp_tool_results
        (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
      VALUES
        (${args.ownerKey}, ${overflowManifestKey(id)}, ${args.toolName},
         ${args.workspaceId}, ${pendingJson}::text::jsonb, false)
    `;
    for (const source of new Set([args.sourceUri, args.sourcePath].filter((value): value is string => Boolean(value)))) {
      const sourceJson = serializeStoredMcpResult({
        content: [],
        _meta: {
          overflowFallbackSource: {
            schemaVersion: 'papercusp.mcp-overflow-fallback-source/v1',
            id,
            source,
          },
        },
      });
      await tx`
        INSERT INTO harness_shared.mcp_tool_results
          (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
        VALUES
          (${args.ownerKey}, ${overflowSourceKey(source)}, ${args.toolName},
           ${args.workspaceId}, ${sourceJson}::text::jsonb, false)
        ON CONFLICT (owner_key, idempotency_key) DO UPDATE
          SET workspace_id = EXCLUDED.workspace_id,
              result = EXCLUDED.result,
              created_at = now()
      `;
    }
  });

  const reference: McpOverflowFallbackReference = {
    id,
    uri: MCP_OVERFLOW_FALLBACK_SCHEME + id,
    byteCount: manifest.byteCount,
    sha256: manifest.sha256,
    expiresAt,
    ownerId: args.ownerId,
    audience: 'owner',
    mediaType: 'application/json',
  };
  const ready = persistMcpOverflowFallback(args, manifest)
    .then(() => true)
    .catch(async (error: unknown) => {
      await markMcpOverflowFallbackFailed(args.ownerKey, args.workspaceId, id).catch(() => undefined);
      console.warn('[mcp-replay] overflow fallback storage failed (' + id + '): ' +
        (error instanceof Error ? error.message : String(error)));
      return false;
    });
  return { reference, ready };
}

async function persistMcpOverflowFallback(
  args: { ownerKey: string; workspaceId: string; toolName: string; payload: Buffer },
  manifest: McpOverflowFallbackManifest,
): Promise<void> {
  const { sql } = getOrgPg();
  const readyJson = serializeStoredMcpResult({
    content: [],
    _meta: { overflowFallback: { ...manifest, state: 'ready' } },
  });
  const batchSize = 24;
  await sql.begin(async (tx) => {
    for (let start = 0; start < manifest.chunkCount; start += batchSize) {
      const indexes = Array.from(
        { length: Math.min(batchSize, manifest.chunkCount - start) },
        (_unused, offset) => start + offset,
      );
      const ownerKeys = indexes.map(() => args.ownerKey);
      const keys = indexes.map((index) => overflowChunkKey(manifest.id, index));
      const toolNames = indexes.map(() => args.toolName);
      const workspaceIds = indexes.map(() => args.workspaceId);
      const results = indexes.map((index) => {
        const bytes = args.payload.subarray(
          index * manifest.chunkBytes,
          Math.min(args.payload.byteLength, (index + 1) * manifest.chunkBytes),
        );
        return serializeStoredMcpResult({
          content: [],
          _meta: { overflowChunk: {
            id: manifest.id,
            index,
            byteCount: bytes.byteLength,
            sha256: sha256Hex(bytes),
            data: bytes.toString('base64'),
          } },
        });
      });
      await tx`
        INSERT INTO harness_shared.mcp_tool_results
          (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
        SELECT rows.owner_key, rows.idempotency_key, rows.tool_name, rows.workspace_id,
               rows.result::text::jsonb, false
          FROM unnest(
            ${ownerKeys}::text[], ${keys}::text[], ${toolNames}::text[],
            ${workspaceIds}::text[], ${results}::text[]
          ) AS rows(owner_key, idempotency_key, tool_name, workspace_id, result)
        ON CONFLICT (owner_key, idempotency_key) DO NOTHING
      `;
    }
    await tx`
      UPDATE harness_shared.mcp_tool_results
         SET result = ${readyJson}::text::jsonb, created_at = now()
       WHERE owner_key = ${args.ownerKey} AND workspace_id = ${args.workspaceId}
         AND idempotency_key = ${overflowManifestKey(manifest.id)}
         AND result->'_meta'->'overflowFallback'->>'state' = 'pending'
    `;
  });
  maybeSweep();
}

async function markMcpOverflowFallbackFailed(ownerKey: string, workspaceId: string, id: string): Promise<void> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ result: unknown }>>`
    SELECT result FROM harness_shared.mcp_tool_results
     WHERE owner_key = ${ownerKey} AND workspace_id = ${workspaceId}
       AND idempotency_key = ${overflowManifestKey(id)}
  `;
  const manifest = manifestFromResult(rows[0]?.result);
  if (!manifest) return;
  const failedJson = serializeStoredMcpResult({
    content: [],
    _meta: { overflowFallback: { ...manifest, state: 'failed' } },
  });
  await sql`
    UPDATE harness_shared.mcp_tool_results
       SET result = ${failedJson}::text::jsonb, created_at = now()
     WHERE owner_key = ${ownerKey} AND workspace_id = ${workspaceId}
       AND idempotency_key = ${overflowManifestKey(id)}
       AND result->'_meta'->'overflowFallback'->>'state' = 'pending'
  `;
}

export async function readMcpOverflowFallbackPage(args: {
  ownerKey: string;
  ownerId: string;
  workspaceId: string;
  id: string;
  byteOffset: number;
  byteLimit: number;
}): Promise<McpOverflowFallbackPage> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.id) ||
    !Number.isSafeInteger(args.byteOffset) || args.byteOffset < 0 ||
    !Number.isSafeInteger(args.byteLimit) || args.byteLimit <= 0 || args.byteLimit > 4_096
  ) return { state: 'missing' };
  const { sql } = getOrgPg();
  const manifests = await sql<Array<{ result: unknown }>>`
    SELECT result FROM harness_shared.mcp_tool_results
     WHERE owner_key = ${args.ownerKey} AND workspace_id = ${args.workspaceId}
       AND idempotency_key = ${overflowManifestKey(args.id)}
       AND created_at > now() - make_interval(secs => ${REPLAY_TTL_MS / 1000})
  `;
  const manifest = manifestFromResult(manifests[0]?.result);
  if (!manifest || manifest.id !== args.id) return { state: 'missing' };
  if (manifest.ownerId !== args.ownerId) return { state: 'forbidden' };
  const expiresAtMs = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) return { state: 'expired' };
  if (manifest.state === 'pending') return { state: 'pending' };
  if (manifest.state === 'failed') return { state: 'failed' };
  if (
    manifest.byteCount > MCP_OVERFLOW_FALLBACK_MAX_BYTES ||
    manifest.chunkCount !== Math.ceil(manifest.byteCount / manifest.chunkBytes)
  ) return { state: 'integrity_mismatch' };

  const byteOffset = Math.min(args.byteOffset, manifest.byteCount);
  const byteLength = Math.min(args.byteLimit, manifest.byteCount - byteOffset);
  const nextOffset = byteOffset + byteLength;
  if (byteLength === 0) return {
    state: 'ready', uri: MCP_OVERFLOW_FALLBACK_SCHEME + args.id,
    page: Buffer.alloc(0), byteOffset, totalBytes: manifest.byteCount,
    sha256: manifest.sha256, expiresAt: manifest.expiresAt, nextOffset: null,
  };
  const firstChunk = Math.floor(byteOffset / manifest.chunkBytes);
  const lastChunk = Math.floor((nextOffset - 1) / manifest.chunkBytes);
  const chunkKeys = Array.from(
    { length: lastChunk - firstChunk + 1 },
    (_unused, offset) => overflowChunkKey(args.id, firstChunk + offset),
  );
  const chunks = await sql<Array<{ idempotency_key: string; result: unknown }>>`
    SELECT idempotency_key, result FROM harness_shared.mcp_tool_results
     WHERE owner_key = ${args.ownerKey} AND workspace_id = ${args.workspaceId}
       AND idempotency_key = ANY(${chunkKeys}::text[])
       AND created_at > now() - make_interval(secs => ${REPLAY_TTL_MS / 1000})
  `;
  const byKey = new Map(chunks.map((row) => [row.idempotency_key, objectAt(row.result)]));
  const pageParts: Buffer[] = [];
  for (let index = firstChunk; index <= lastChunk; index += 1) {
    const metadata = objectAt(objectAt(byKey.get(overflowChunkKey(args.id, index))?._meta)?.overflowChunk);
    const expectedStart = index * manifest.chunkBytes;
    const expectedBytes = Math.min(manifest.chunkBytes, manifest.byteCount - expectedStart);
    if (
      metadata?.id !== args.id || metadata.index !== index || metadata.byteCount !== expectedBytes ||
      typeof metadata.sha256 !== 'string' || typeof metadata.data !== 'string'
    ) return { state: 'integrity_mismatch' };
    const bytes = Buffer.from(metadata.data, 'base64');
    if (
      bytes.byteLength !== expectedBytes || bytes.toString('base64') !== metadata.data ||
      sha256Hex(bytes) !== metadata.sha256
    ) return { state: 'integrity_mismatch' };
    pageParts.push(bytes.subarray(
      Math.max(0, byteOffset - expectedStart),
      Math.min(bytes.byteLength, nextOffset - expectedStart),
    ));
  }
  const page = Buffer.concat(pageParts);
  if (page.byteLength !== byteLength) return { state: 'integrity_mismatch' };
  return {
    state: 'ready', uri: MCP_OVERFLOW_FALLBACK_SCHEME + args.id,
    page, byteOffset, totalBytes: manifest.byteCount,
    sha256: manifest.sha256, expiresAt: manifest.expiresAt,
    nextOffset: nextOffset < manifest.byteCount ? nextOffset : null,
  };
}

/** Resolve a failed/pending scratch spill's original URI or path to its durable fallback. */
export async function readMcpOverflowFallbackPageForSource(args: {
  ownerKey: string;
  ownerId: string;
  workspaceId: string;
  source: string;
  byteOffset: number;
  byteLimit: number;
}): Promise<McpOverflowFallbackPage> {
  if (!args.source || args.source.length > 4_096) return { state: 'missing' };
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ result: unknown }>>`
    SELECT result FROM harness_shared.mcp_tool_results
     WHERE owner_key = ${args.ownerKey} AND workspace_id = ${args.workspaceId}
       AND idempotency_key = ${overflowSourceKey(args.source)}
       AND created_at > now() - make_interval(secs => ${REPLAY_TTL_MS / 1000})
  `;
  const sourceRow = objectAt(rows[0]?.result);
  const sourceManifest = objectAt(objectAt(sourceRow?._meta)?.overflowFallbackSource);
  if (
    sourceManifest?.schemaVersion !== 'papercusp.mcp-overflow-fallback-source/v1' ||
    sourceManifest.source !== args.source || typeof sourceManifest.id !== 'string'
  ) return { state: 'missing' };
  return readMcpOverflowFallbackPage({
    ownerKey: args.ownerKey,
    ownerId: args.ownerId,
    workspaceId: args.workspaceId,
    id: sourceManifest.id,
    byteOffset: args.byteOffset,
    byteLimit: args.byteLimit,
  });
}

/** Validate a caller-supplied idempotency key — non-empty string, bounded. */
export function validIdempotencyKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const k = v.trim();
  if (k.length === 0 || k.length > KEY_MAX) return null;
  return k;
}

function decodeStoredMcpResult(result: unknown, isError: boolean): StoredMcpResult | null {
  const decoded =
    typeof result === 'string'
      ? (() => {
          try {
            return JSON.parse(result) as unknown;
          } catch {
            return null;
          }
        })()
      : result;
  if (!decoded || typeof decoded !== 'object') return null;
  const stored = decoded as StoredMcpResult;
  return {
    ...stored,
    ...(isError ? { isError: true } : {}),
  };
}

export function isPendingMcpResult(result: StoredMcpResult | null | undefined): boolean {
  return result?._meta?.state === PENDING_MCP_RESULT_STATE;
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
  const stored = decodeStoredMcpResult(row.result, row.is_error);
  // Pending receipts are coordination state, not terminal tool results. The
  // MCP handler calls this before invoking the tool on a retry, so returning a
  // pending marker here would make the retry look like a completed write.
  if (!stored || isPendingMcpResult(stored)) return null;
  return {
    ...stored,
    // Tag the replay so the caller KNOWS this is the stored outcome of a
    // prior execution, not a fresh run.
    _meta: { ...(stored._meta ?? {}), replayed: true },
  };
}

/**
 * Atomically reserve an idempotency key for an asynchronous write.
 *
 * The transport stores the handler's returned result after dispatch. Inserting
 * the pending receipt before returning means that write is a harmless no-op
 * on the same key, while a retry can observe the pending row and avoid
 * starting a second background operation.
 */
export async function claimPendingMcpResult(args: {
  ownerKey: string;
  idempotencyKey: string;
  toolName: string;
  workspaceId: string;
  result: StoredMcpResult;
}): Promise<PendingMcpResultClaim> {
  const { sql } = getOrgPg();
  const resultJson = serializeStoredMcpResult(args.result);
  const inserted = await sql<Array<{ result: unknown; is_error: boolean }>>`
    INSERT INTO harness_shared.mcp_tool_results
      (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
    VALUES
      (${args.ownerKey}, ${args.idempotencyKey}, ${args.toolName},
       ${args.workspaceId}, ${resultJson}::text::jsonb, ${args.result.isError === true})
    ON CONFLICT (owner_key, idempotency_key) DO NOTHING
    RETURNING result, is_error
  `;
  if (inserted[0]) {
    return { claimed: true, pending: true, result: decodeStoredMcpResult(inserted[0].result, inserted[0].is_error) };
  }

  const existing = await sql<Array<{ result: unknown; is_error: boolean }>>`
    SELECT result, is_error
      FROM harness_shared.mcp_tool_results
     WHERE owner_key = ${args.ownerKey} AND idempotency_key = ${args.idempotencyKey}
  `;
  const current = existing[0]
    ? decodeStoredMcpResult(existing[0].result, existing[0].is_error)
    : null;
  return {
    claimed: false,
    pending: isPendingMcpResult(current),
    result: current,
  };
}

export function serializeStoredMcpResult(result: StoredMcpResult): string {
  const contentParts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item && typeof item === 'object') {
        const typed = item as Record<string, unknown>;
        if (typed.type === 'text' && typeof typed.text === 'string') {
          // JSON.stringify the text so a plain string is correctly quoted/escaped
          // (a bare `${typed.text}` produces invalid JSON for a non-JSON string, and
          // silently retypes a JSON-string value to an object — breaking replay
          // round-trip). Stringifying a single string is the cheap leg; the P1-4 win
          // is avoiding JSON.stringify on the WHOLE result/large content arrays.
          contentParts.push(`{"type":"text","text":${JSON.stringify(typed.text)}}`);
        } else {
          contentParts.push(JSON.stringify(item));
        }
      }
    }
  }
  // Build the body WITHOUT the closing brace, append isError/_meta, THEN close —
  // appending after a closed `{...}` produced `{...},"_meta":…` (trailing content
  // past the root object → "invalid input syntax for type json" on ::jsonb).
  let json = `{"content":[${contentParts.join(',')}]`;
  if (result.isError) json += ',"isError":true';
  if (result._meta) json += `,"_meta":${JSON.stringify(result._meta)}`;
  // EI-21508946450217911: a tool that declares an outputSchema (scheduler:get_next,
  // every object-rooted projected tool) MUST return structuredContent — the MCP
  // SDK's CLIENT-side check throws -32600 "has an output schema but did not return
  // structured content" otherwise. Dropping this field here made every idempotent
  // replay of such a tool schema-invalid, breaking the prescribed recovery path
  // itself: the caller retrying a timed-out call could never get a schema-valid
  // verdict back. Serialize it when present so a replay carries the same shape the
  // fresh response had.
  if (result.structuredContent !== undefined) {
    json += `,"structuredContent":${JSON.stringify(result.structuredContent)}`;
  }
  json += '}';
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
  // EI-21508946450217911: structuredContent is part of the stored payload now —
  // a large one must count toward the same event-loop gate the content does,
  // or the gate under-measures by exactly the field this exists to bound.
  if (args.result.structuredContent !== undefined) {
    estimatedSize += JSON.stringify(args.result.structuredContent).length;
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

/**
 * Replace a pending receipt with the terminal result of its background write.
 *
 * A terminal receipt is never overwritten: this preserves first-write-wins if
 * a recovery path races a completion callback. If the transport failed before
 * it persisted the pending row, the INSERT fallback still records the terminal
 * result so a later retry can replay it.
 */
export async function finalizePendingMcpResult(args: {
  ownerKey: string;
  idempotencyKey: string;
  toolName: string;
  workspaceId: string;
  result: StoredMcpResult;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  const resultJson = serializeStoredMcpResult(args.result);
  const rows = await sql<Array<{ result: unknown }>>`
    INSERT INTO harness_shared.mcp_tool_results
      (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
    VALUES
      (${args.ownerKey}, ${args.idempotencyKey}, ${args.toolName},
       ${args.workspaceId}, ${resultJson}::text::jsonb, ${args.result.isError === true})
    ON CONFLICT (owner_key, idempotency_key) DO UPDATE
      SET tool_name = EXCLUDED.tool_name,
          workspace_id = EXCLUDED.workspace_id,
          result = EXCLUDED.result,
          is_error = EXCLUDED.is_error,
          created_at = now()
    WHERE mcp_tool_results.result->'_meta'->>'state' = ${PENDING_MCP_RESULT_STATE}
    RETURNING result
  `;
  maybeSweep();
  return rows.length > 0;
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
