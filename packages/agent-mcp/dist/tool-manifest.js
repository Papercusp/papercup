"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reloadToolManifest = reloadToolManifest;
exports.hasToolManifest = hasToolManifest;
exports.applyToolManifest = applyToolManifest;
const node_path_1 = __importDefault(require("node:path"));
const host_platform_1 = require("@papercusp/host-platform");
// `undefined` = not yet loaded; `null` = no manifest (expose all).
let cache;
function manifestPath() {
    return (process.env.AGENT_MCP_TOOL_MANIFEST ||
        node_path_1.default.join((0, host_platform_1.getHostPlatform)().homedir(), '.papercusp', 'tool-manifest.json'));
}
function load() {
    if (cache !== undefined)
        return cache;
    try {
        const text = (0, host_platform_1.getHostPlatform)().readTextFileSync(manifestPath());
        if (text === null) {
            cache = null; // missing or unreadable → expose all
            return cache;
        }
        const raw = JSON.parse(text);
        const names = Array.isArray(raw) ? raw : raw?.tools;
        if (!Array.isArray(names) ||
            names.length === 0 ||
            !names.every((n) => typeof n === 'string')) {
            cache = null;
            return cache;
        }
        cache = { order: new Map(names.map((n, i) => [n, i])) };
    }
    catch {
        cache = null; // unparseable → expose all
    }
    return cache;
}
/** Drop the cached manifest so the next call re-reads from disk. */
function reloadToolManifest() {
    cache = undefined;
}
/** True if a non-empty manifest is currently configured. */
function hasToolManifest() {
    return load() !== null;
}
/**
 * Restrict `tools` to the configured manifest (preserving manifest order) and
 * drop anything not listed. With no manifest, or when `bypass` is set (snapshot
 * generation), returns `tools` unchanged.
 *
 * Generic over `{ name }` so it works for both `listMcpProjections()` results
 * and the stdio catalog mapping.
 */
function applyToolManifest(tools, opts) {
    if (opts?.bypass)
        return [...tools];
    const m = load();
    if (!m)
        return [...tools];
    return tools
        .filter((t) => m.order.has(t.name))
        .sort((a, b) => m.order.get(a.name) - m.order.get(b.name));
}
