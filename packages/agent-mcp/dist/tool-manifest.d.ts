/**
 * Pinned tool manifest — freezes the MCP `tools/list` surface so it is
 * byte-stable across reconnects/reloads.
 *
 * WHY: an SDK consuming this server (e.g. a stateless Anthropic-format client) inlines the tool
 * catalog into the prompt prefix. If the exposed set changes mid-session
 * (a re-fetch after the operator hot-reloads while you're adding tools),
 * the catalog bytes change and the upstream prompt cache busts — re-creating
 * the whole conversation prefix (the dominant token cost; see
 * `apps/operator/docs/` token-usage analysis).
 *
 * A manifest decouples "tool exists in the registry" from "tool is exposed to
 * agents": you add tools freely during development, and they only enter the
 * exposed surface when you regenerate the manifest (a deliberate, occasional
 * act — see `scripts/snapshot-tools.mjs`). Within a process the manifest is
 * read once and cached, so the surface never shifts under a live session.
 *
 * Manifest file (JSON), either form:
 *   ["actions_recent", "harness_status", ...]
 *   { "tools": ["actions_recent", "harness_status", ...] }
 *
 * Location: $AGENT_MCP_TOOL_MANIFEST, else ~/.papercusp/tool-manifest.json.
 * Absent / empty / unparseable manifest => expose everything (no-op default),
 * so this is fully backward-compatible until you generate a snapshot.
 */
/** Drop the cached manifest so the next call re-reads from disk. */
export declare function reloadToolManifest(): void;
/** True if a non-empty manifest is currently configured. */
export declare function hasToolManifest(): boolean;
/**
 * Restrict `tools` to the configured manifest (preserving manifest order) and
 * drop anything not listed. With no manifest, or when `bypass` is set (snapshot
 * generation), returns `tools` unchanged.
 *
 * Generic over `{ name }` so it works for both `listMcpProjections()` results
 * and the stdio catalog mapping.
 */
export declare function applyToolManifest<T extends {
    name: string;
}>(tools: readonly T[], opts?: {
    bypass?: boolean;
}): T[];
