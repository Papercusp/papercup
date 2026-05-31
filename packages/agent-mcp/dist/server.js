"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatch = dispatch;
exports.startServer = startServer;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const zod_to_json_schema_1 = require("zod-to-json-schema");
const db_org_1 = require("@papercusp/db-org");
const auth_1 = require("./auth");
const registry_1 = require("./registry");
/**
 * Run a tool by name with bearer-derived principal. The single entry
 * point used by both the MCP transport handler and in-process callers
 * (Operator/Oracle).
 */
async function dispatch(opts) {
    const tool = (0, registry_1.lookup)(opts.toolName);
    if (!tool) {
        return { ok: false, error: { code: 'unknown_tool', message: `No tool named "${opts.toolName}"` } };
    }
    const principal = await (0, auth_1.resolveBearer)(opts.bearer);
    if (!principal) {
        return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer token did not resolve to a principal' } };
    }
    if (!principal.capabilities.has(tool.capability)) {
        return {
            ok: false,
            error: {
                code: 'missing_capability',
                message: `Principal ${principal.slug} lacks capability "${tool.capability}" (tool: ${tool.name})`,
            },
        };
    }
    // Validate args via Zod.
    const parsed = tool.args.safeParse(opts.args);
    if (!parsed.success) {
        return {
            ok: false,
            error: { code: 'invalid_args', message: parsed.error.message },
        };
    }
    try {
        const response = await (0, db_org_1.withWorkspace)(principal.workspaceId, async (tx) => {
            const ctx = {
                principal,
                tx,
                log: (level, msg, meta) => {
                    // Minimal logger; replace with substrate logger in Phase E.
                    // eslint-disable-next-line no-console
                    console[level === 'info' ? 'log' : level](`[agent-mcp][${tool.name}][${principal.slug}] ${msg}`, meta ?? '');
                },
            };
            return await tool.handler(parsed.data, ctx);
        });
        return { ok: true, response };
    }
    catch (err) {
        return {
            ok: false,
            error: {
                code: 'handler_error',
                message: err instanceof Error ? err.message : String(err),
            },
        };
    }
}
async function startServer(opts = {}) {
    const stdio = opts.stdio ?? true;
    const bearerEnv = opts.bearerEnv ?? 'AGENT_MCP_BEARER';
    const server = new index_js_1.Server({ name: 'agent-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
        const bearer = process.env[bearerEnv] ?? '';
        const principal = bearer ? await (0, auth_1.resolveBearer)(bearer) : null;
        const catalog = (0, registry_1.getCatalog)();
        const tools = catalog
            .filter((t) => !principal || principal.capabilities.has(t.capability))
            .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: (0, zod_to_json_schema_1.zodToJsonSchema)(t.args, {
                target: 'jsonSchema7',
            }),
        }));
        return { tools };
    });
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (req) => {
        const bearer = process.env[bearerEnv] ?? '';
        const result = await dispatch({
            toolName: req.params.name,
            args: req.params.arguments ?? {},
            bearer,
        });
        if (!result.ok) {
            return {
                isError: true,
                content: [
                    { type: 'text', text: `${result.error?.code}: ${result.error?.message}` },
                ],
            };
        }
        const r = result.response;
        return {
            content: [{ type: 'text', text: JSON.stringify(r) }],
        };
    });
    if (stdio) {
        const transport = new stdio_js_1.StdioServerTransport();
        await server.connect(transport);
    }
}
