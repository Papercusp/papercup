/**
 * Opt-in tool-allowlist for the agent-mcp HTTP transport's `tools/list`.
 *
 * The shared `/api/mcp` endpoint exposes the FULL projected catalog — for a
 * role-`operator` (or superuser) caller that's ~300 tools, because most tools
 * declare no `agentRoles` restriction and are therefore visible to every role.
 * Claude Code DEFERS a surface that large (every tool must be `ToolSearch`-
 * activated before it can be called), which makes a persona brain — the
 * operator — flail: it fires multiple `ToolSearch`es per turn, guesses
 * colon/underscore name variants, and occasionally loops to the wall-clock cap.
 * Root cause + fix: `voice-persona-production-readiness-2026-06-02` P-009.
 *
 * The fix is an OPT-IN `?tools=a:b,c:d` query param. A caller that knows its
 * small working set (operator:converse passes the ~50 `ALL_AGENT_MCP_TOOLS`)
 * gets ONLY those tools in `tools/list`. Shrinking the surface is half the fix;
 * the other half is the spawn-side `ENABLE_TOOL_SEARCH=false` lever
 * (`RunAgentChatOptions.disableToolSearch`) that loads the now-small set
 * DIRECTLY instead of deferring it. (The per-tool MCP `_meta.anthropic/
 * alwaysLoad` marker was tried and is NOT honored over the HTTP transport on
 * claude-code 2.1.x — verified — so the env lever does the non-deferral.)
 *
 * Absent / empty `?tools=` → no filtering at all, so every other spawn
 * (worker / scoper / validator / a bare probe) keeps its full role surface.
 * Names are matched against the MCP catalog name (the colon form the registry
 * exposes, e.g. `harness:status`); unknown names in the param are simply
 * ignored (a stale name never hides the rest of the set). This is a LISTING
 * hint only — it does NOT gate `tools/call`. The operator is superuser and the
 * role-allowlist already governs what is callable; the allowlist exists purely
 * to shrink the deferred surface, so a tool omitted from `?tools=` that gets
 * called anyway still dispatches normally.
 */

/**
 * Parse the `?tools=` query value into a name set, or `null` when absent/empty
 * (the "no filtering" signal). Comma-separated; whitespace trimmed; blanks
 * dropped.
 */
export function parseToolsAllowlist(raw: string | null | undefined): Set<string> | null {
  if (raw == null) return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return null;
  return new Set(names);
}

/**
 * Filter MCP tool listings to the allowlist. `null` allowlist → return every
 * listing untouched (the worker/scoper/probe path). Matches on `listing.name`
 * (the colon MCP name).
 */
export function filterListingsByAllowlist<T extends { name: string }>(
  listings: readonly T[],
  allow: Set<string> | null,
): T[] {
  if (!allow) return [...listings];
  return listings.filter((t) => allow.has(t.name));
}

/* ── Per-session MUTABLE tool surface (dynamic-tool-surface-2026-07-01) ────────
 *
 * The `?tools=` allowlist above is a SEED, not a hard cap: a seeded session can
 * GROW its advertised surface at runtime via `ctx.activateTools` (fired by
 * `tools:find`), and the transport emits `notifications/tools/list_changed` so a
 * `listChanged`-capable client (omp, codex) re-fetches `tools/list` and can call
 * the surfaced tools. This dissolves the focus/token/reachability trilemma into
 * "small seed + expand on demand": the seed keeps token cost + focus tight, and
 * on-intent activation keeps the long tail reachable — no ~140k-token full
 * catalog up front. Claude is unaffected: it launches with NO `?tools=` seed
 * (it self-defers via ToolSearch), so no surface is ever created for it and no
 * `list_changed` is ever fired at it.
 *
 * This is ephemeral per-CONNECTION state (it dies with the session), so an
 * in-memory Map keyed by the su session identity (`uiClientId`) is the correct
 * home per the storage policy (per-connection state is the explicit
 * not-Postgres exception). It is bounded by a lazy TTL sweep on access (no
 * bespoke timer to keep visible) plus a hard entry cap as a runaway backstop.
 */

interface SessionSurface {
  /** The live advertised set: seed ∪ everything activated so far. */
  tools: Set<string>;
  /** Last touch (ms) — recency for the TTL sweep. */
  touched: number;
}

const sessionSurfaces = new Map<string, SessionSurface>();

/** Idle sessions older than this are swept lazily on the next access. */
const SESSION_SURFACE_TTL_MS = 6 * 60 * 60 * 1000; // 6h ≫ any single agent session
/** Hard backstop against unbounded growth (a runaway or key explosion). */
const SESSION_SURFACE_MAX = 4096;

/** Exported for tests only — reset the module-scoped store between cases. */
export function __resetSessionSurfaces(): void {
  sessionSurfaces.clear();
}

function sweepSessionSurfaces(nowMs: number): void {
  // Cheap TTL pass — drop idle sessions.
  for (const [k, v] of sessionSurfaces) {
    if (nowMs - v.touched > SESSION_SURFACE_TTL_MS) sessionSurfaces.delete(k);
  }
  if (sessionSurfaces.size <= SESSION_SURFACE_MAX) return;
  // Still over the cap after TTL → evict oldest-touched down to 90%.
  const entries = [...sessionSurfaces.entries()].sort((a, b) => a[1].touched - b[1].touched);
  const target = Math.floor(SESSION_SURFACE_MAX * 0.9);
  for (const [k] of entries) {
    if (sessionSurfaces.size <= target) break;
    sessionSurfaces.delete(k);
  }
}

/**
 * Resolve the LIVE listing allowlist for a session — the mutable equivalent of
 * `parseToolsAllowlist`, used by `tools/list`.
 *
 * - `seed === null` (no `?tools=`) → returns `null`: full catalog, unchanged.
 *   No surface entry is created (so `activateTools` stays a no-op for this
 *   session — exactly the full-catalog / Claude path).
 * - `sessionKey === null` (no stable session id) → returns the raw `seed`:
 *   static behaviour, since growth can't be tracked without a stable key.
 * - otherwise → returns the session's mutable set, created (seeded) on first
 *   access and re-seeded defensively (the seed is the invariant floor) on
 *   every subsequent `tools/list`.
 *
 * The FIRST `tools/list` of a connection is what creates the entry; every real
 * MCP client lists before it calls, so the entry exists by the time
 * `tools:find` → `activateSessionTools` runs.
 */
export function getSessionSurface(
  sessionKey: string | null | undefined,
  seed: Set<string> | null,
  nowMs: number = Date.now(),
): Set<string> | null {
  if (!seed) return null; // no seed ⇒ full catalog ⇒ nothing to track
  if (!sessionKey) return seed; // no stable key ⇒ static (pre-dynamic behaviour)
  sweepSessionSurfaces(nowMs);
  let e = sessionSurfaces.get(sessionKey);
  if (!e) {
    e = { tools: new Set(seed), touched: nowMs };
    sessionSurfaces.set(sessionKey, e);
  } else {
    for (const t of seed) e.tools.add(t); // seed is the floor — re-add defensively
    e.touched = nowMs;
  }
  return e.tools;
}

/**
 * Grow a seeded session's surface by `toolNames` (the server-side half of
 * `ctx.activateTools`). Returns true iff at least one genuinely-new name was
 * added — the caller fires `notifications/tools/list_changed` only then, so a
 * no-op activation doesn't spam re-fetches.
 *
 * Only grows an ALREADY-SEEDED session (an entry created by `getSessionSurface`
 * on the connection's first `tools/list`). A session with no entry is either a
 * full-catalog session (nothing to expand — it already sees everything) or a
 * pre-list race; both correctly no-op.
 */
export function activateSessionTools(
  sessionKey: string | null | undefined,
  toolNames: readonly string[],
  nowMs: number = Date.now(),
): boolean {
  if (!sessionKey) return false;
  const e = sessionSurfaces.get(sessionKey);
  if (!e) return false; // only grow a seeded session
  let added = false;
  for (const n of toolNames) {
    if (typeof n === 'string' && n.length > 0 && !e.tools.has(n)) {
      e.tools.add(n);
      added = true;
    }
  }
  if (added) e.touched = nowMs;
  return added;
}
