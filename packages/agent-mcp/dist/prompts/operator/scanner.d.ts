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
declare const _default: import("@papercusp/tooldef").PromptDefinition;
export default _default;
