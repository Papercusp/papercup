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
