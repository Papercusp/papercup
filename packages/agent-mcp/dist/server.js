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
exports.listResources = listResources;
exports.readResource = readResource;
exports.listPrompts = listPrompts;
exports.getPrompt = getPrompt;
exports.startServer = startServer;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const auth_1 = require("./auth");
const tool_schema_sanitize_1 = require("./tool-schema-sanitize");
const tooldef_1 = require("@papercusp/tooldef");
const tool_manifest_1 = require("./tool-manifest");
const tooldef_2 = require("@papercusp/tooldef");
const tooldef_3 = require("@papercusp/tooldef");
/**
 * Run a tool by name with bearer-derived principal. The single entry
 * point used by both the MCP transport handler and in-process callers
 * (Operator/Oracle).
 */
async function dispatch(opts) {
    const tool = (0, tooldef_1.lookup)(opts.toolName);
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
    // Validate args via the tool's Standard Schema validator.
    const parsed = await (0, tooldef_1.standardValidate)(tool.args, opts.args);
    if (!parsed.ok) {
        return {
            ok: false,
            error: { code: 'invalid_args', message: (0, tooldef_1.formatIssues)(parsed.issues) },
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
            return await tool.handler(parsed.value, ctx);
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
/**
 * Enumerate every resource the bearer is allowed to see. Templated
 * resources expand via their `list` callback (one URI per harness, etc.);
 * concrete resources contribute one entry each.
 */
async function listResources(bearer) {
    const principal = await (0, auth_1.resolveBearer)(bearer);
    if (!principal) {
        return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
    }
    const visible = (0, tooldef_2.getResourceCatalog)().filter((r) => principal.capabilities.has(r.capability));
    try {
        const collected = await (0, db_org_1.withWorkspace)(principal.workspaceId, async (tx) => {
            const out = [];
            for (const def of visible) {
                const ctx = {
                    principal,
                    tx,
                    log: (level, msg, meta) => {
                        // eslint-disable-next-line no-console
                        console[level === 'info' ? 'log' : level](`[agent-mcp][resource:list][${def.name}] ${msg}`, meta ?? '');
                    },
                };
                if (def.list) {
                    try {
                        const expanded = await def.list(ctx);
                        out.push(...expanded);
                    }
                    catch (err) {
                        // A single resource's list() failing must not block the rest.
                        // eslint-disable-next-line no-console
                        console.warn(`[agent-mcp] resource list() failed for ${def.name}:`, err instanceof Error ? err.message : err);
                    }
                }
                else {
                    out.push({
                        uri: def.uri,
                        name: def.name,
                        description: def.description,
                        mimeType: def.mimeType,
                    });
                }
            }
            return out;
        });
        return { ok: true, resources: collected };
    }
    catch (err) {
        return {
            ok: false,
            error: { code: 'list_error', message: err instanceof Error ? err.message : String(err) },
        };
    }
}
/**
 * Read a single resource by URI. Matches the URI against registered
 * templates, capability-checks the bearer, then runs the resource's
 * `read` callback inside a workspace-bound transaction.
 */
async function readResource(opts) {
    const matched = (0, tooldef_2.matchResource)(opts.uri);
    if (!matched) {
        return { ok: false, error: { code: 'unknown_resource', message: `No resource matches URI "${opts.uri}"` } };
    }
    const principal = await (0, auth_1.resolveBearer)(opts.bearer);
    if (!principal) {
        return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
    }
    if (!principal.capabilities.has(matched.def.capability)) {
        return {
            ok: false,
            error: {
                code: 'missing_capability',
                message: `Principal ${principal.slug} lacks capability "${matched.def.capability}" (resource: ${matched.def.name})`,
            },
        };
    }
    try {
        const contents = await (0, db_org_1.withWorkspace)(principal.workspaceId, async (tx) => {
            const ctx = {
                principal,
                tx,
                log: (level, msg, meta) => {
                    // eslint-disable-next-line no-console
                    console[level === 'info' ? 'log' : level](`[agent-mcp][resource:read][${matched.def.name}][${principal.slug}] ${msg}`, meta ?? '');
                },
            };
            return await matched.def.read(opts.uri, ctx);
        });
        return { ok: true, contents };
    }
    catch (err) {
        return {
            ok: false,
            error: { code: 'read_error', message: err instanceof Error ? err.message : String(err) },
        };
    }
}
/** Enumerate prompts visible to the bearer. */
async function listPrompts(bearer) {
    const principal = await (0, auth_1.resolveBearer)(bearer);
    if (!principal) {
        return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
    }
    const visible = (0, tooldef_3.getPromptCatalog)().filter((p) => !p.capability || principal.capabilities.has(p.capability));
    return {
        ok: true,
        prompts: visible.map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments,
        })),
    };
}
/** Render a prompt by name with the given args. */
async function getPrompt(opts) {
    const def = (0, tooldef_3.lookupPrompt)(opts.name);
    if (!def) {
        return { ok: false, error: { code: 'unknown_prompt', message: `No prompt named "${opts.name}"` } };
    }
    const principal = await (0, auth_1.resolveBearer)(opts.bearer);
    if (!principal) {
        return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
    }
    if (def.capability && !principal.capabilities.has(def.capability)) {
        return {
            ok: false,
            error: {
                code: 'missing_capability',
                message: `Principal ${principal.slug} lacks capability "${def.capability}" (prompt: ${def.name})`,
            },
        };
    }
    // Enforce required-arg presence.
    for (const argSpec of def.arguments ?? []) {
        if (argSpec.required && !(argSpec.name in opts.args)) {
            return {
                ok: false,
                error: {
                    code: 'missing_argument',
                    message: `Prompt "${def.name}" requires argument "${argSpec.name}"`,
                },
            };
        }
    }
    try {
        const result = await (0, db_org_1.withWorkspace)(principal.workspaceId, async (tx) => {
            const ctx = {
                principal,
                tx,
                log: (level, msg, meta) => {
                    // eslint-disable-next-line no-console
                    console[level === 'info' ? 'log' : level](`[agent-mcp][prompt:get][${def.name}][${principal.slug}] ${msg}`, meta ?? '');
                },
            };
            return await def.render(opts.args, ctx);
        });
        return { ok: true, result };
    }
    catch (err) {
        return {
            ok: false,
            error: { code: 'render_error', message: err instanceof Error ? err.message : String(err) },
        };
    }
}
async function startServer(opts = {}) {
    const stdio = opts.stdio ?? true;
    const bearerEnv = opts.bearerEnv ?? 'AGENT_MCP_BEARER';
    const server = new index_js_1.Server({ name: 'agent-mcp', version: '0.1.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
        const bearer = process.env[bearerEnv] ?? '';
        const principal = bearer ? await (0, auth_1.resolveBearer)(bearer) : null;
        const catalog = (0, tooldef_1.getCatalog)();
        const tools = catalog
            .filter((t) => !principal || principal.capabilities.has(t.capability))
            .map((t) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const inputSchema = zod_1.z.toJSONSchema(t.args);
            delete inputSchema.$schema;
            // Objectify boolean sub-schemas (z.unknown() → `true`) so strict
            // consumers (Ollama) can parse the tool surface. See tool-schema-sanitize.ts.
            return { name: t.name, description: t.description, inputSchema: (0, tool_schema_sanitize_1.sanitizeToolSchema)(inputSchema) };
        });
        // Pin to the tool manifest (if configured) for cache-stable parity with
        // the HTTP transport. No-op when no manifest is present. See tool-manifest.ts.
        return { tools: (0, tool_manifest_1.applyToolManifest)(tools) };
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
        // Format-aware serialization (token-efficient-tool-result-formats P-005) —
        // the same single serializer the HTTP path uses. stdio is an agent-facing
        // MCP transport, so it defaults to compact; a client can override per call
        // via `_meta.format`. The envelope (nextCursor/degraded) rides in `_meta`.
        const r = result.response;
        const meta = req.params._meta;
        const serialized = (0, tooldef_1.serializeToolResponse)(r, (0, tooldef_1.formatOptsFromCtx)({ requestedFormat: meta?.format, requestedStructured: meta?.structured === true, transport: 'mcp' }, (0, tooldef_1.lookupByMcpName)(req.params.name)?.resultEligibility));
        return {
            content: serialized.content,
            ...(Object.keys(serialized._meta).length > 0 ? { _meta: serialized._meta } : {}),
            ...(serialized.structuredContent !== undefined ? { structuredContent: serialized.structuredContent } : {}),
        };
    });
    server.setRequestHandler(types_js_1.ListResourcesRequestSchema, async () => {
        const bearer = process.env[bearerEnv] ?? '';
        const result = await listResources(bearer);
        return { resources: result.ok ? (result.resources ?? []) : [] };
    });
    server.setRequestHandler(types_js_1.ReadResourceRequestSchema, async (req) => {
        const bearer = process.env[bearerEnv] ?? '';
        const result = await readResource({ uri: req.params.uri, bearer });
        if (!result.ok) {
            throw new Error(`${result.error?.code}: ${result.error?.message}`);
        }
        return { contents: [result.contents] };
    });
    server.setRequestHandler(types_js_1.ListPromptsRequestSchema, async () => {
        const bearer = process.env[bearerEnv] ?? '';
        const result = await listPrompts(bearer);
        return { prompts: result.ok ? (result.prompts ?? []) : [] };
    });
    server.setRequestHandler(types_js_1.GetPromptRequestSchema, async (req) => {
        const bearer = process.env[bearerEnv] ?? '';
        const result = await getPrompt({
            name: req.params.name,
            args: (req.params.arguments ?? {}),
            bearer,
        });
        if (!result.ok) {
            throw new Error(`${result.error?.code}: ${result.error?.message}`);
        }
        return {
            description: result.result.description,
            messages: result.result.messages,
        };
    });
    if (stdio) {
        const transport = new stdio_js_1.StdioServerTransport();
        await server.connect(transport);
    }
}
