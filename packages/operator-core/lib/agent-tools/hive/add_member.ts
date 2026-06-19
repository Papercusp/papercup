/**
 * hive:add-member — wire an existing harness in as a MEMBER of a local Hive
 * (EI-1582 — the missing agent-facing PRODUCER for `hive_slug`).
 *
 * The producer `addHarnessToHive` (./_add-member.ts) has existed since
 * shared-hive-federation P-004, but was never exposed as a tool — so a Hive
 * created member-less (e.g. the papercup→papercusp rebrand: ensurePapercuspHive
 * only CREATES the home, never wires `papercup` in) was UNREMEDIABLE by any
 * agent. With no member, `hive:survey` falls back to a WORKSPACE-WIDE scope
 * (survey.ts: "membership not wired ⇒ a workspace-wide survey"), which sweeps
 * benchmark/instance-harness debris as "ready" → Queen-unresolvable escalations
 * → the curse-storm (EI-1525/1578/1581). Wiring the real member scopes the
 * survey to it and closes that exposure. This tool ships the producer so an su
 * OR the Queen can self-remediate.
 *
 * Membership is a REGISTRY edit only (sets `ProjectEntry.hive_slug`); it never
 * moves the harness folder or its run data, and it best-effort seeds the
 * member's `system:git-sync` routine. Idempotent (re-adding to the same Hive is
 * a no-op success) and reversible (re-point by removing first, or via the
 * registry). NOT destructive, so — unlike hive:dissolve / hive:leave — it is
 * neither root-only nor confirm-gated; the Queen needs it to self-heal an
 * empty-frontier hive (EI-1581).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { addHarnessToHive } from './_add-member';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'hive:add-member',
  profile: 'engineer',
  description:
    "Wire an existing harness in as a MEMBER of a local Hive (sets its hive_slug so its work federates within the Hive and surfaces in the Queen's member-scoped hive:survey). Registry edit only — never moves the harness folder or run data; best-effort seeds the member's git-sync routine. Idempotent (re-adding is a no-op success). Use this to remediate a member-less Hive whose Queen surveys workspace-wide and escalates out-of-scope debris.",
  guidance: {
    when: "A Hive has no members so hive:survey falls back to workspace-wide scope (frontier empty / Queen-unresolvable escalations) — wire the real harness in. Also the producer for shared-hive federation membership.",
    notWhen:
      'Adding a person/device to a Hive (that is admission, a separate concern). Removing a member (re-point via the registry / hive:leave for a joined remote hive). Nesting a Hive home as a member (rejected — Hives compose as peers).',
    chaining:
      'hive:list / hive:get to find the Hive home + the member slug → hive:add-member → hive:start (or hive:wake) so the Queen surveys the now-scoped frontier → hive:survey to confirm members[] is non-empty + scope is hive-local.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z
      .string()
      .min(1)
      .max(120)
      .describe("The Hive's home harness slug (a kind:'hive' harness) to add the member to."),
    member: z
      .string()
      .min(1)
      .max(120)
      .describe('The existing harness slug to wire in as a member (sets its hive_slug to the Hive home).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const result = await addHarnessToHive({
      workspaceId,
      hiveHomeSlug: args.hive,
      memberHarnessSlug: args.member,
    });
    return text({ ...result });
  },
});
