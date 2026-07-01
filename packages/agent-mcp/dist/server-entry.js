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
const host_platform_1 = require("@papercusp/host-platform");
const desktop_1 = require("@papercusp/host-platform/desktop");
const server_1 = require("./server");
// This stdio process always runs on the user's machine next to the operator —
// "desktop" for HostPlatform purposes. Without a registration every
// getHostPlatform() consumer (agent:role, operator:scanner, tool-manifest)
// throws at request time.
(0, host_platform_1.registerHostPlatform)(desktop_1.desktopHostPlatform);
(0, server_1.startServer)({ stdio: true }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[agent-mcp] server fatal:', err);
    process.exit(1);
});
