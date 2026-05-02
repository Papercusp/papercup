#!/usr/bin/env node
"use strict";
/**
 * Standalone MCP server entrypoint.
 *
 * Spawned by:
 *   - pi sessions (per /api/agent-mcp/spawn-pi response)
 *   - external claude-code consumers
 *
 * Reads bearer from $AGENT_MCP_BEARER, talks MCP over stdio.
 * Tools self-register by importing `./bootstrap`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("./bootstrap");
const server_1 = require("./server");
(0, server_1.startServer)({ stdio: true }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[agent-mcp] server fatal:', err);
    process.exit(1);
});
