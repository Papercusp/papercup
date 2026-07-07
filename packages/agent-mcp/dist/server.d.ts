/**
 * Agent MCP server.
 *
 * Wires the catalog (populated by importing `tools/**`) into an MCP
 * server. Each `tools/list` and `tools/call` request resolves the caller
 * to a Principal via the bearer token, checks the tool's capability
 * against the principal's grants, and runs the handler inside a
 * transaction with `app.workspace_id` set.
 *
 * Transports:
 *   - stdio (out-of-process pi sessions / external claude-code consumers)
 *   - in-process: import `dispatch()` directly (Operator/Oracle running
 *     in the same Node process call the same handlers without going
 *     over a wire — same contract, no transport overhead).
 */
import type { Principal, PromptResult, ResourceContents, ResourceListEntry, ToolDefinition, ToolResult, ToolResponse } from '@papercusp/tooldef';
export interface DispatchOptions {
    toolName: string;
    args: unknown;
    bearer: string;
}
export interface DispatchResult {
    ok: boolean;
    response?: ToolResponse | ToolResult;
    error?: {
        code: string;
        message: string;
    };
}
/**
 * EI-7068: some MCP clients double-encode tool arguments — instead of sending
 * the real arguments object, they JSON.stringify the WHOLE thing and wrap it
 * under a single top-level `args` key: `{ args: '{"content":"...","kind":"x"}' }`.
 * Every tool's Zod schema then sees its real fields as undefined at the top
 * level and rejects with invalid_args — indistinguishable, from a single
 * tool's schema, from the caller simply omitting required fields. This is a
 * TRANSPORT-layer client bug, not any one tool's problem (patching per-tool
 * schemas to accept it would just spread the workaround), so it's detected +
 * unwrapped ONCE here, before per-tool validation.
 *
 * Guarded narrowly so it can never misfire on a tool that legitimately has its
 * own `args` field: only unwraps when the incoming object's ONLY own key is
 * literally "args" AND that value is a string which JSON.parses to a plain
 * (non-null, non-array) object. Anything else (a real args:{...} object field,
 * extra sibling keys, non-JSON string, array/primitive) passes through
 * untouched and hits normal per-tool validation as before.
 */
export declare function unwrapDoubleEncodedArgs(input: unknown): unknown;
/**
 * Run a tool by name with bearer-derived principal. The single entry
 * point used by both the MCP transport handler and in-process callers
 * (Operator/Oracle).
 */
export declare function dispatch(opts: DispatchOptions): Promise<DispatchResult>;
export interface ListResourcesResult {
    ok: boolean;
    resources?: ResourceListEntry[];
    error?: {
        code: string;
        message: string;
    };
}
export interface ReadResourceOptions {
    uri: string;
    bearer: string;
}
export interface ReadResourceResult {
    ok: boolean;
    contents?: ResourceContents;
    error?: {
        code: string;
        message: string;
    };
}
/**
 * Enumerate every resource the bearer is allowed to see. Templated
 * resources expand via their `list` callback (one URI per harness, etc.);
 * concrete resources contribute one entry each.
 */
export declare function listResources(bearer: string): Promise<ListResourcesResult>;
/**
 * Read a single resource by URI. Matches the URI against registered
 * templates, capability-checks the bearer, then runs the resource's
 * `read` callback inside a workspace-bound transaction.
 */
export declare function readResource(opts: ReadResourceOptions): Promise<ReadResourceResult>;
export interface ListPromptsResult {
    ok: boolean;
    prompts?: Array<{
        name: string;
        description: string;
        arguments?: Array<{
            name: string;
            description?: string;
            required?: boolean;
        }>;
    }>;
    error?: {
        code: string;
        message: string;
    };
}
export interface GetPromptOptions {
    name: string;
    args: Record<string, string>;
    bearer: string;
}
export interface GetPromptResult {
    ok: boolean;
    result?: PromptResult;
    error?: {
        code: string;
        message: string;
    };
}
/** Enumerate prompts visible to the bearer. */
export declare function listPrompts(bearer: string): Promise<ListPromptsResult>;
/** Render a prompt by name with the given args. */
export declare function getPrompt(opts: GetPromptOptions): Promise<GetPromptResult>;
export interface StartServerOptions {
    /** Use stdio transport. Default true. */
    stdio?: boolean;
    /** Bearer source for stdio transport — env var name. Default `AGENT_MCP_BEARER`. */
    bearerEnv?: string;
}
export declare function startServer(opts?: StartServerOptions): Promise<void>;
export type { Principal, ToolDefinition, ToolResponse };
