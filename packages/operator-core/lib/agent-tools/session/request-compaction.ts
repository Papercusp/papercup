/**
 * session:request-compaction — compact THIS session now, at a clean stopping point.
 *
 * agent-managed-compaction-2026-07-01. The agent calls this when it has reached a
 * good stopping point (typically near its soft compaction limit — see
 * config:set-compaction-limit and the per-turn `context: N/limit` signal). The
 * model cannot type a slash command itself, so the harness injects
 * `/compact <focus>` into the session's OWN psu-pty TUI — idle-gated (mode:'turn'),
 * so it runs AFTER this turn ends (the stopping point). The projected
 * `# Compact Instructions` (CLAUDE.md) carry the standing what-to-preserve
 * guidance; `focus` names this unit of work.
 *
 * Claude-only in practice: only psu-hosted TUIs expose the inject socket. The
 * operator converse-brain compacts programmatically; OMP self-compacts natively;
 * Codex has no compaction. No live host ⇒ a clear error, never a silent no-op.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { findLiveHost, injectIntoHost } from '../../events/await/psu-pty-discovery';

/** Focus applied when the agent names none — mirrors the compaction.claude recipe. */
const DEFAULT_FOCUS =
  'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls; drop resolved tool output and superseded state.';

export default defineTool({
  name: 'session:request-compaction',
  description:
    'Compact THIS session now, at a clean stopping point (near your soft compaction limit). The harness types /compact into your own TUI; it runs after this turn ends. Pass focus to name what to preserve this compaction.',
  capability: 'coord:write',
  guidance: {
    when: 'You are near your compaction limit AND at a clean stopping point (a finished unit of work — tests green, an edit landed, a decision logged).',
    notWhen:
      'Mid-task — reach a stopping point first. To change WHEN this fires — config:set-compaction-limit.',
    seeAlso: ['config:set-compaction-limit (tune when this fires)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 10 } },
  args: z.object({
    focus: z
      .string()
      .max(600)
      .optional()
      .describe('What to preserve/emphasize in this compaction (defaults to the standard preserve set).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const host = findLiveHost(identity.ownerId);
    if (!host) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_live_pty_host',
              note: 'No live psu-pty host for this session — /compact can only be injected into a psu-hosted TUI. If running interactively, type /compact yourself.',
            }),
          },
        ],
        isError: true,
      };
    }
    const focus = (args.focus ?? DEFAULT_FOCUS).trim();
    const ok = await injectIntoHost(host.sock, { mode: 'turn', data: `/compact ${focus}` });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok,
            requested: ok,
            note: ok
              ? 'Compaction queued — /compact runs when this turn ends (idle-gated). Wrap up now and stop.'
              : 'Failed to reach the session TUI host socket; try again or compact manually.',
          }),
        },
      ],
    };
  },
});
