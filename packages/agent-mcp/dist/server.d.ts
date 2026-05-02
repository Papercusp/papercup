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
import type { Principal, ToolDefinition, ToolResponse } from './types';
export interface DispatchOptions {
    toolName: string;
    args: unknown;
    bearer: string;
}
export interface DispatchResult {
    ok: boolean;
    response?: ToolResponse;
    error?: {
        code: string;
        message: string;
    };
}
/**
 * Run a tool by name with bearer-derived principal. The single entry
 * point used by both the MCP transport handler and in-process callers
 * (Operator/Oracle).
 */
export declare function dispatch(opts: DispatchOptions): Promise<DispatchResult>;
export interface StartServerOptions {
    /** Use stdio transport. Default true. */
    stdio?: boolean;
    /** Bearer source for stdio transport — env var name. Default `AGENT_MCP_BEARER`. */
    bearerEnv?: string;
}
export declare function startServer(opts?: StartServerOptions): Promise<void>;
export type { Principal, ToolDefinition, ToolResponse };
