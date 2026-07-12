/**
 * Per-session MCP `initialize.instructions` enrichment — the mechanics.
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-001, decisions D-005/D-003).
 *
 * The SDK `Server` registers its own `initialize` request handler in its
 * constructor (`_oninitialize`), which returns the STATIC `instructions`
 * string given at construction. The original papercusp-su-memory-2026-05-25
 * P-003 work deferred per-session enrichment because overriding that handler
 * looked like re-implementing the protocol-version negotiation. This module
 * closes the gap WITHOUT re-implementing it: we take the SDK's already-stored
 * handler off the protocol's `_requestHandlers` map and DELEGATE to it — the
 * version negotiation and the `_clientCapabilities`/`_clientVersion` side
 * effects stay SDK-owned — then enrich ONLY the `instructions` field of the
 * result (session-start memory prelude: user + harness memories + the
 * agent-insights index, via `buildMcpPrelude`).
 *
 * Never-throws: any enrichment failure (or a null/empty enrichment) returns
 * the SDK's own result unchanged, so a broken memory backend can never break
 * session establishment. Pinned by
 * `__tests__/mcp-initialize-enrich.test.ts` — including against the REAL SDK
 * Server, so an SDK upgrade that changes the stored-handler shape or the
 * negotiation semantics fails the suite instead of silently dropping the
 * prelude (or worse, the negotiation).
 */

export type InitializeHandler = (req: unknown, extra: unknown) => Promise<unknown>;

/**
 * Fetch the SDK's stored `initialize` handler from the protocol's private
 * `_requestHandlers` map. Returns null when the shape is not what we expect
 * (e.g. an SDK upgrade moved the map) — the caller then leaves the SDK
 * handler in place and the session falls back to static instructions.
 *
 * Note the stored value is the protocol's WRAPPER (it re-parses the request
 * against the schema before calling `_oninitialize`), so calling it with an
 * already-parsed request is safe — the parse is idempotent.
 */
export function takeStoredInitializeHandler(server: unknown): InitializeHandler | null {
  const map = (server as { _requestHandlers?: Map<string, unknown> } | null | undefined)
    ?._requestHandlers;
  if (!map || typeof map.get !== 'function') return null;
  const handler = map.get('initialize');
  return typeof handler === 'function' ? (handler as InitializeHandler) : null;
}

/**
 * Wrap the SDK initialize handler: delegate the whole request (negotiation +
 * client-info side effects), then best-effort enrich the `instructions`
 * field. `enrich` receives the SDK's own instructions string (the static
 * base) and the request `extra` (URL/headers live there); it returns the
 * REPLACEMENT instructions, or null/undefined to keep the base.
 */
export function wrapInitializeWithInstructions(
  original: InitializeHandler,
  enrich: (base: string | undefined, extra: unknown) => Promise<string | null | undefined>,
): InitializeHandler {
  return async (req, extra) => {
    const base = (await original(req, extra)) as Record<string, unknown>;
    try {
      const baseInstructions =
        typeof base.instructions === 'string' ? base.instructions : undefined;
      const enriched = await enrich(baseInstructions, extra);
      if (typeof enriched === 'string' && enriched.length > 0 && enriched !== baseInstructions) {
        return { ...base, instructions: enriched };
      }
    } catch {
      // Best-effort by contract: a failed enrichment must never break the
      // initialize response — fall through to the SDK's own result.
    }
    return base;
  };
}
