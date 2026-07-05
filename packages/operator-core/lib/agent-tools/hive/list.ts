/**
 * pot:list — the workspace-local hives (kind:'hive' harnesses) at a glance
 * (hive-tool-namespace-2026-06-08 P-002, D-001).
 *
 * The local-lifecycle counterpart to `discovery:hives` (the P2P directory of
 * joinable network hives). Returns each hive's `resolveHive` descriptor (slug +
 * deployment + wake) plus a single batched live-agent count — ONE fleet read for
 * all hives, never an N-per-hive fan-out. Rich per-hive detail (bees, frontier)
 * is `pot:get`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { listFleetAssignments } from '../../fleet/assignments';
import { listHives, liveAgentCountByHarness } from './_resolve';

export default defineTool({
  name: 'pot:list',
  profile: 'engineer',
  description:
    "The workspace-local hives (kind:'hive' harnesses — the Hives): each with its home slug, deployment target, wake (scheduled? next/last fire), and a live-agent count. The local-lifecycle view; for joinable network hives use discovery:hives, for per-bee placement detail use fleet:assignments, for one hive in depth use pot:get.",
  guidance: {
    when: 'You want the workspace-local hives (the Hives) and their wake/load at a glance.',
    notWhen:
      'Browsing joinable hives across the P2P network — that is discovery:hives. The raw per-agent fleet view — fleet:assignments. One hive in depth — pot:get.',
    chaining: 'pot:get { slug } to drill into one; pot:create to add one; pot:dissolve to tear one down.',
    seeAlso: [
      'pot:get (drill into one hive in depth)',
      'pot:create (stand up a new hive)',
      'fleet:assignments (the raw per-agent view across the workspace)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const hives = await listHives(workspaceId);

    // One batched fleet read → distinct live agents per hive harness (no N fan-out).
    const counts =
      hives.length > 0
        ? liveAgentCountByHarness(await listFleetAssignments({ workspaceId }))
        : new Map<string, number>();

    const out = hives.map((h) => ({ ...h, liveAgents: counts.get(h.slug) ?? 0 }));
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, count: out.length, hives: out }) },
      ],
    };
  },
});
