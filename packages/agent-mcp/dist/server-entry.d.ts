#!/usr/bin/env node
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
import './bootstrap';
