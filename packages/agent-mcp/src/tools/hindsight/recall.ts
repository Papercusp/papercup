/**
 * Recall memories from the workspace's Hindsight bank.
 *
 * **DEPRECATED 2026-05-09.** No live writers populate the Hindsight bank
 * for harness workflows; this tool returns useless empty results in
 * practice and competes with the `features:*` MCP tools (which are the
 * canonical agent-side memory surface). Scheduled for removal one
 * release after agent traffic is verified to have moved off it.
 *
 * If you reach this code from a tool dispatch in production, file an
 * issue with the calling agent so we can route them to `features:get`
 * / `features:history` / `features:search` instead.
 *
 * Bank ID is auth-derived: workspace registry's `companyId` field
 * resolves to `paperclip::<companyId>`. Body-supplied scope is rejected.
 * If the workspace has no `companyId`, returns degraded with empty
 * results — does not throw.
 */

import { z } from 'zod';
import { join } from 'node:path';
import { getHostPlatform } from '@papercusp/host-platform';
import { defineTool } from '@papercusp/tooldef';

interface WorkspaceRegistryEntry {
  id: string;
  name: string;
  companyId?: string | null;
}

function resolveCompanyId(workspaceId: string): string | null {
  const platform = getHostPlatform();
  const path = join(platform.homedir(), '.papercusp-workspaces', 'registry.json');
  const raw = platform.readTextFileSync(path);
  if (raw === null) return null;
  try {
    const reg = JSON.parse(raw) as { workspaces: WorkspaceRegistryEntry[] };
    const ws = reg.workspaces.find((w) => w.id === workspaceId);
    return ws?.companyId ?? null;
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'hindsight:recall',
  capability: 'hindsight:recall',
  guidance: {
    when: 'User asks "have we seen X before?", "what did the last debugger find?", or you need cross-agent shared memory about a topic.',
    notWhen: 'For YOUR conversation history with the user, just rely on the chat context — hindsight is for cross-agent shared memory, not session memory. For LIVE state (current task list, harness status), call the dedicated tool — hindsight may be stale.',
  },
  args: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).default(10),
  }),
  async handler(args, ctx) {
    // Deprecation telemetry — every call is a candidate for migration
    // to features:* tools. Logged at info level (not warn) so it
    // doesn't noise up dashboards while we're confirming zero traffic.
    ctx.log('info', 'hindsight:recall is deprecated; prefer features:get/features:history/features:search', {
      principal: ctx.principal.slug,
      query_len: args.query.length,
    });
    const companyId = resolveCompanyId(ctx.principal.workspaceId);
    if (!companyId) {
      return {
        data: [],
        degraded: true,
        degradedReasons: ['hindsight_not_configured_for_workspace', 'tool_deprecated_use_features_tools'],
      };
    }
    const bank = `paperclip::${companyId}`;
    // Hindsight client invocation. v1 wires through an HTTP shim if the
    // hindsight MCP isn't directly callable in-process; for now we
    // return a degraded placeholder describing the resolved bank so
    // pi/Operator can at least see what would be queried.
    return {
      data: [],
      degraded: true,
      degradedReasons: [
        `hindsight client not wired in v1; would query bank=${bank} query=${JSON.stringify(args.query)}`,
      ],
    };
  },
});
