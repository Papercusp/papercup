/**
 * coord:presence — list active coordination agents and what they are
 * doing right now.
 *
 * Joins the live liveness layer (harness_shared.coord_presence) with
 * the durable record (harness_shared.power_user_sessions). Sessions
 * whose heartbeat is older than 10 min are returned in `stale`, not
 * `active`. agent-coordination-architecture-v2 §4.2 / §4.3.
 *
 * The scope-resolution + snapshot assembly live in `../presence-snapshot`
 * (shared with the coord:inbox P-010 re-bootstrap, so both read the SAME
 * hive-scoped roster); this tool is the thin read surface over it.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolvePresenceScope, assemblePresenceSnapshot } from '../presence-snapshot';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:presence',
  description:
    "List ACTIVE coordination agents (fresh heartbeat) and what they're doing. Defaults to your HIVE (the agents you actually coordinate with); pass scope=workspace|all for the wider admin/Queen view. Stale sessions (heartbeat >10 min) are summarised unless you pass include_stale.",
  guidance: {
    when: '"Who else is working right now, and on what?" — before starting work that might overlap. Default scope is your Hive; use scope=workspace/all for the whole box.',
    notWhen: 'Checking whether a specific file is free — use locks:queue for that. Re-reading the roster every turn to track peers — the [coord+N] lifecycle deltas already carry intent/claim/completion transitions; tail those instead (see chaining).',
    chaining:
      'Read-once + tail (presence-v2 P-008/D-006): this snapshot is byte-stable (P-009 — identity+state carry no churning timestamps, one roster as_of). Read it ONCE when you need the roster, then rely on the [coord+N] lifecycle deltas (intent/claim/completion) for peer transitions rather than re-reading. The liveness scalar (lastActiveSecAgo) is point-in-time at as_of. After a context compaction the roster baseline is re-injected automatically (P-010), so you never coordinate off a stale baseline.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    scope: z
      .enum(['hive', 'workspace', 'all'])
      .optional()
      .describe('hive (DEFAULT) = your Hive\'s agents + federated peers for it; workspace = the whole workspace; all = every workspace (admin/Queen). A caller with no Hive (SU/operator) falls back to workspace.'),
    hive: z
      .string()
      .optional()
      .describe('Explicit Hive slug to scope to (overrides caller-hive resolution; implies scope=hive).'),
    workspace: z
      .string()
      .optional()
      .describe('Workspace id for workspace/hive scope; omit to use the caller\'s.'),
    include_stale: z
      .boolean()
      .optional()
      .describe('Also return the full stale roster (default false — stale is summarised only; the live answer is `active`).'),
  }),
  async handler(args, ctx) {
    // P-004 hive-scoped read (D-002): resolve the effective scope from ctx + args
    // (hive default → caller's home Hive; SU/unmapped → workspace fallback), then
    // assemble the byte-stable snapshot (P-009). Both steps are the SAME functions
    // the coord:inbox re-bootstrap uses, so the roster never diverges.
    const c = (ctx ?? {}) as { workspaceId?: string | null; harnessSlug?: string | null };
    const resolved = await resolvePresenceScope(c, {
      scope: args.scope,
      hive: args.hive,
      workspace: args.workspace,
    });
    const snapshot = await assemblePresenceSnapshot(resolved, { includeStale: args.include_stale });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(snapshot),
        },
      ],
    };
  },
});
