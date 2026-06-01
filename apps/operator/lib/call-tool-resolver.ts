/**
 * Operator-side resolver for the `callTool` seam. Plan:
 * calltool-endpoint-seam-2026-06-01 (Phase A, P-001).
 *
 * Maps a projected-tool name → its canonical route + (Phase E) direct-dispatch
 * eligibility, then installs it via `configureCallTool`.
 *
 * Why a map, not a pure convention: operator tools are reached at heterogeneous
 * routes — the framework default `/api/agent-tools/<name>`, the
 * `/api/agent-mcp/operator-<verb>` shims, and bespoke shims (`oracle:chat` →
 * `/api/oracle/chat`). The canonical route is the one the tool's CURRENT
 * consumers hit, so migrating a call site to `callTool(name)` stays
 * behavior-preserving. We can't introspect the projected registry on the client
 * (importing it pulls server code into the SPA bundle — the blank-page trap,
 * see `operator-vite-spa-server-leak-blank-page`), so the routes are an explicit
 * map seeded with the direct-dispatch candidates (the self-contained streaming
 * tools) and grown / verified per call site during the Phase B migration.
 *
 * NOT callTool(name) candidates: parameterized routes (`agent_chats:chat` →
 * `/api/harness/<slug>/agent-chats/<id>/messages`; harness-scoped brainstorm /
 * architect) carry path params, so they migrate to `callRoute(builtPath)`.
 *
 * `directEligible` is `false` for everything in Phase A — direct dispatch is off
 * until Phase E flips it per audited tool with a RequestContext parity test
 * (D-003). The route-preserving (`sys:http`) default already carries workspace
 * scope via `installWorkspaceHeaderFetch`, so this is behavior-preserving today.
 */
import { configureCallTool, type ToolResolution } from './call-tool';

/**
 * Tool name → canonical route (the shim its consumers currently hit). Seeded
 * with the verified static-route streaming tools; extend per call site during
 * the Phase B migration after confirming the route matches the consumer's
 * current `fetch`.
 */
const TOOL_ROUTES: Record<string, string> = {
  'oracle:chat': '/api/oracle/chat',
  'operator:scan': '/api/agent-mcp/operator-scan',
  'operator:converse': '/api/agent-mcp/operator-converse',
};

export function operatorToolResolver(name: string): ToolResolution {
  return {
    route: TOOL_ROUTES[name] ?? `/api/agent-tools/${name.replaceAll(':', '/')}`,
    // Phase A: direct dispatch off for all (D-001/D-003). Phase E flips this per
    // audited tool once its handler is self-contained + a parity test passes.
    directEligible: false,
  };
}

/**
 * Install the operator resolver into the `callTool` seam. Call once at app init
 * (RootSyncProvider, module-eval). Idempotent — re-registers the same resolver.
 */
export function installCallToolResolver(): void {
  configureCallTool(operatorToolResolver);
}
