#!/usr/bin/env npx tsx
/**
 * Entry for the resilient local MCP proxy (mcp-host-availability-resilience-2026-06-22
 * P-005). Always-up local process that fronts :3070/api/mcp so a deploy restart of
 * :3070 is invisible to MCP clients (retry-on-refused). OPT-IN: nothing connects here
 * until a client config (~/.claude.json / psu launcher) is repointed at this port (P-006),
 * so running it is harmless. Config via env:
 *   PAPERCUSP_MCP_PROXY_PORT          listen port (default 9071; :3071-3079 are taken on the dev box)
 *   PAPERCUSP_MCP_PROXY_TARGET_HOST   upstream host (default 127.0.0.1)
 *   PAPERCUSP_MCP_PROXY_TARGET_PORT   upstream port (default PAPERCUSP_HONO_PORT or 3070)
 *   PAPERCUSP_MCP_PROXY_RETRY_MS      retry-on-refused window (default 45000)
 */
import { startMcpProxy } from '../lib/mcp-proxy/proxy';

startMcpProxy({
  listenPort: Number(process.env.PAPERCUSP_MCP_PROXY_PORT ?? 9071),
  targetHost: process.env.PAPERCUSP_MCP_PROXY_TARGET_HOST ?? '127.0.0.1',
  targetPort: Number(process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT ?? process.env.PAPERCUSP_HONO_PORT ?? 3070),
  retryWindowMs: Number(process.env.PAPERCUSP_MCP_PROXY_RETRY_MS ?? 45_000),
});
