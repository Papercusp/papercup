/**
 * mcp-base-url.ts — resolve the BASE URL that agent MCP `.mcp.json` entries point at (WI-573).
 *
 * WHY: the agent MCP endpoint is `<operator>/api/mcp`, and the operator (`:3070`) RESTARTS on every
 * deploy. A native MCP client (Claude Code / Codex / OMP) pinned directly at `:3070` drops its
 * connection on that restart and does not re-discover tools → a "toolless session". The always-up
 * local proxy (apps/operator/lib/mcp-proxy/proxy.ts, default `127.0.0.1:9071`) fronts `:3070` and
 * RETRIES a refused upstream, so the restart is invisible to the client.
 *
 * OPT-IN (safe by construction): we only redirect agents through the proxy when the operator
 * environment explicitly sets `PAPERCUSP_MCP_PROXY_BASE` (e.g. `http://127.0.0.1:9071` on the dev
 * box, where the proxy runs). Unset (CI, a fresh deploy with no proxy, tests) → the caller's own
 * operator base is used unchanged, so this can NEVER break an environment that has no proxy. The
 * signed/superuser query params + the bearer header are preserved either way (the proxy is a pure
 * passthrough), so auth is unaffected.
 */

/**
 * The base URL to embed in an agent's MCP server config. Returns the configured proxy base when
 * `PAPERCUSP_MCP_PROXY_BASE` is set (deploy-restart-resilient), else the operator base unchanged.
 * Trailing slashes are normalized off so callers can append `/api/mcp` consistently.
 */
export function resolveAgentMcpBaseUrl(operatorBaseUrl: string): string {
  const proxy = process.env.PAPERCUSP_MCP_PROXY_BASE?.trim();
  const base = proxy && proxy.length > 0 ? proxy : operatorBaseUrl;
  return base.replace(/\/$/, '');
}

/**
 * Resolve an INHERITED `PAPERCUSP_OPERATOR_URL` (which may already carry a
 * `/api/mcp` suffix — some producers, e.g. dbos/orchestrator-runner.ts, set it
 * that way) down to the bare origin a native MCP client's OWN `.mcp.json`
 * template expects, routed through the resilient `:9071` proxy when
 * configured.
 *
 * WHY: a client's own MCP template (`~/.claude.json`'s `papercusp-su` entry)
 * unconditionally appends `/api/mcp` itself. A resumed session that inherits
 * the already-suffixed form ends up with the doubled, 404ing path
 * `.../api/mcp/api/mcp` and its papercusp-su MCP never connects. Use this for
 * any `PAPERCUSP_OPERATOR_URL` export a spawned `claude`/`omp` child will feed
 * straight into its own MCP config — for a raw-HTTP consumer that expects the
 * suffix preserved as originally set, see capability-bash's own
 * suffix-preserving wrapper instead.
 */
export function resolveInheritedOperatorBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return raw;
  const base = trimmed.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  return resolveAgentMcpBaseUrl(base);
}
