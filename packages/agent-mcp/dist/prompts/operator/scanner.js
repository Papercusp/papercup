"use strict";
/**
 * `operator:scanner` — substrate-owned scanner-role prompt (the
 * "Operator persona"). Mirrors apps/operator/lib/operator-prompt-system.ts
 * but resolves the canonical scanner.md fresh on each request so any
 * substrate edits surface immediately to MCP consumers.
 *
 * No arguments — returns the raw scanner persona.
 *
 * Host coupling: reaches the filesystem via `@papercusp/host-platform`
 * rather than `node:fs` directly. On desktop hosts this is the same
 * `readFileSync` underneath; on server hosts the call throws cleanly
 * (and the caller should never have asked for this prompt without a
 * filesystem to read from in the first place).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = require("node:path");
const host_platform_1 = require("@papercusp/host-platform");
const tooldef_1 = require("@papercusp/tooldef");
const module_dir_1 = require("../module-dir");
function findScannerMd() {
    const platform = (0, host_platform_1.getHostPlatform)();
    const here = (0, module_dir_1.moduleDir)(import.meta);
    const candidates = [
        ...(here
            ? [
                (0, node_path_1.resolve)(here, '../../../../../libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md'),
                (0, node_path_1.resolve)(here, '../../../../libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md'),
            ]
            : []),
        (0, node_path_1.resolve)(process.cwd(), 'libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md'),
        // The operator hosts run with cwd apps/operator (systemd units + Tauri
        // sidecar) — the repo root is two levels up from there.
        (0, node_path_1.resolve)(process.cwd(), '../../libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md'),
    ];
    for (const path of candidates) {
        const text = platform.readTextFileSync(path);
        if (text !== null)
            return { path, text };
    }
    return null;
}
exports.default = (0, tooldef_1.definePrompt)({
    name: 'operator:scanner',
    description: 'Substrate-owned Operator scanner-role prompt. Defines tier table, schema, anti-patterns. No arguments.',
    async render() {
        const found = findScannerMd();
        if (!found) {
            throw new Error('Could not locate scanner.md on disk.');
        }
        return {
            description: 'Operator scanner persona — substrate canonical version.',
            messages: [{ role: 'system', content: { type: 'text', text: found.text } }],
        };
    },
});
