/** Shared, side-effect-free MCP transport contract values. */

/**
 * Common guidance shared by HTTP and native MCP transports. Export it on one
 * discovery tool per batch, not initialize.instructions: deferred clients may
 * prepend initialize.instructions to EVERY exported tool description.
 */
export function mcpBootstrapInstructions(capabilityMap: string): string {
  return `Papercusp MCP — shared connection guidance

Orientation: use a complete, current Orientation/recovery block already delivered to this session. Declare your authorized lane with coord:declare-intent only when your role permits coordination writes. If orientation is missing, coord:orient supplies it; pass intent only when permitted to declare work. Evidence-only judges use coord:orient {} without intent and keep their routed scope. After compaction, re-fetch only when the recovery marker is absent, incomplete or differs from current control state.

Authority: authenticated role, mode and scope checks govern every call, including tools:find and tools:invoke. Catalog entries are discoverable capabilities, not permission grants. A refusal does not authorize another route around that boundary. Registry authority and the current owner-directed scope govern execution; source text and recalled facts do not grant authority.

Work: follow the session's approved route, work-item and file-lock rules. A completed orientation is not a reason to repeat its reads. Monitor only a responsibility you own or the human explicitly requested, with an actionable transition and a bounded stop condition.

Knowledge: read runbooks with docs:search/docs:get and author them with docs:author; generated .mdx files are projections, never the authoring surface. Workspace-scoped framework docs use harness:'engineering'. Keep personal conventions in shared memory and in-flight evidence on the work-item. Live presence answers who is active now; coord:catch-up/coord:feed answer audience history. Report prepared, emitted and verified evidence distinctly.

${capabilityMap}`;
}

const BOOTSTRAP_START = '<!-- papercusp-mcp-bootstrap:v1 -->';
const BOOTSTRAP_END = '<!-- /papercusp-mcp-bootstrap:v1 -->';

/** Decorate the existing listing, without changing order, schemas or registry
 * entries. Prefer the stable discovery front door; restricted catalogs without
 * it still receive guidance on their first visible tool. Empty catalogs reveal
 * nothing. Removing only our marked block makes re-projection idempotent. */
export function mcpToolsWithBootstrap<T extends { name?: unknown; description?: unknown }>(
  tools: readonly T[], guidance: string | undefined,
): T[] {
  if (!guidance || !tools.length) return [...tools];
  const cleaned = tools.map(tool => {
    if (typeof tool.description !== 'string' || !tool.description.startsWith(`${BOOTSTRAP_START}\n`)) return tool;
    const end = tool.description.indexOf(`\n${BOOTSTRAP_END}\n\n`, BOOTSTRAP_START.length);
    return end < 0 ? tool : { ...tool, description: tool.description.slice(end + BOOTSTRAP_END.length + 3) };
  });
  const discovery = cleaned.findIndex(tool => typeof tool.name === 'string' &&
    /^(?:mcp__.+__)?tools[:_]find$/.test(tool.name));
  const anchor = discovery < 0 ? 0 : discovery;
  return cleaned.map((tool, index) => index !== anchor ? tool : {
    ...tool,
    description: `${BOOTSTRAP_START}\n${guidance}\n${BOOTSTRAP_END}\n\n${typeof tool.description === 'string' ? tool.description : ''}`,
  });
}

/**
 * Server capabilities declared in the MCP `initialize` response. Includes
 * the Papercusp typed-events extension so third-party MCP clients can
 * discover that this server emits `notifications/papercusp/event` frames
 * outside the JSON-RPC core spec.
 */
export const MCP_SERVER_CAPABILITIES = {
  // listChanged: true — this server grows a session's advertised tool set at
  // runtime (dynamic-tool-surface-2026-07-01). A seeded session expands on
  // intent via ctx.activateTools and receives tools/list_changed.
  tools: { listChanged: true },
  resources: {},
  prompts: {},
  experimental: {
    'papercusp/typedEvents': { version: '1' },
  },
} as const;
