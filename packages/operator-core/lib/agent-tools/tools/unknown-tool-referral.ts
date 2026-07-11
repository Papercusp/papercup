/**
 * unknown-tool-referral — moment-of-failure tool discoverability (EI-9011, generalized).
 *
 * When a tool call misses the registry (`unknown_tool`), the error text is the ONE carrier
 * every MCP client (Claude Code, OMP, codex) renders at the exact moment the agent needs
 * redirection — an initialize-instructions banner read 100k tokens earlier demonstrably
 * loses to this moment (EI-9011: the agent concluded a named tool "doesn't exist" after a
 * client-side ToolSearch miss and degraded to hand-rolled polling). So the unknown_tool
 * error carries:
 *   1. closest catalog matches (typo / format-variant recovery — `locks_acquire` vs
 *      `locks:acquire` vs `mcp__papercusp-su__locks_acquire` all normalize to the same key);
 *   2. the standing referral: tools:invoke calls ANY catalog tool by name without loading
 *      it; tools:find searches the FULL server-side catalog (not the client-advertised
 *      subset) and activates matches.
 *
 * Pure + registry-read-only. Shared by both `unknown_tool` emission sites in
 * _mcp-handler.ts (the tools:invoke dispatch engine + the tools/call fall-through).
 */
import { listAllProjectedTools, normalizeMcpName } from '@papercusp/agent-mcp';

/**
 * Normalize a tool name for comparison: strip the client's `mcp__<server>__`
 * wrapper and treat `:`, `_`, `.`, `-` as one separator (clients rewrite
 * `:` → `_` when advertising).
 *
 * ALIAS of the registry's canonical normalizer (tooldef `normalizeMcpName`) —
 * the SAME function tools:invoke uses to RESOLVE a name (WI-3930). Sharing one
 * implementation guarantees the name a miss SUGGESTS ("did you mean X?") is a
 * name tools:invoke can actually resolve; a second copy could silently drift and
 * suggest a form the resolver rejects. Kept as a named export for existing
 * callers/tests.
 */
export const normalizeToolName = normalizeMcpName;

/** Cheap similarity for suggestion ranking: exact-normalized ≫ substring ≫ token overlap. */
function scoreCandidate(requestedNorm: string, candidateNorm: string): number {
  if (candidateNorm === requestedNorm) return 1000;
  if (candidateNorm.includes(requestedNorm) || requestedNorm.includes(candidateNorm)) return 500;
  const reqTokens = new Set(requestedNorm.split(':').filter(Boolean));
  const candTokens = candidateNorm.split(':').filter(Boolean);
  let overlap = 0;
  for (const t of candTokens) {
    if (reqTokens.has(t)) overlap += 2;
    else if ([...reqTokens].some((r) => r.length >= 3 && (t.includes(r) || r.includes(t)))) overlap += 1;
  }
  return overlap;
}

/**
 * Up to `limit` closest MCP tool names for a requested name that missed the registry.
 * Empty when nothing scores above zero (an unrelated string earns no fabricated matches).
 */
export function suggestClosestToolNames(requested: string, limit = 3): string[] {
  const requestedNorm = normalizeToolName(requested);
  if (!requestedNorm) return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const t of listAllProjectedTools()) {
    const name = t.expose?.mcp?.name;
    if (!name) continue;
    const score = scoreCandidate(requestedNorm, normalizeToolName(name));
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/**
 * Render the full unknown_tool error text: `unknown_tool: …` prefix (kept EXACTLY so
 * existing error-code matching keeps working), closest matches when any, and the referral.
 */
export function unknownToolReferral(requested: string): string {
  const suggestions = suggestClosestToolNames(requested);
  const didYouMean = suggestions.length > 0 ? ` Closest catalog matches: ${suggestions.join(', ')}.` : '';
  return (
    `unknown_tool: no tool named "${requested}".${didYouMean} ` +
    `Any catalog tool is callable WITHOUT loading it: tools:invoke { name, args }. ` +
    `tools:find("<intent or name>") searches the FULL server-side catalog (your client's ` +
    `own tool search only indexes the advertised subset — a miss there does not mean the ` +
    `tool doesn't exist) and activates matches for this session.`
  );
}
