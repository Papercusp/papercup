/**
 * locks:check_command — verdict for a raw shell command against the named-lock
 * registry (Phase 8, P-026). The reachable surface a PreToolUse Bash hook
 * (or an agent) queries to learn whether a command touches a resource that is
 * mid-restart/migration. Returns { decision: allow|warn|block, matched: [...] }.
 *
 * Activation (NOT enabled by default — a Bash hook gates EVERY agent on the
 * box): add a PreToolUse `Bash` hook that POSTs the command to
 * /api/agent-tools/locks/check_command and denies on decision === 'block'.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  matchCommandToSubstitutions,
  strongestTier,
  type SubstitutionMatch,
} from '../../bash-substitution/match';
import { getSubstitutionRows } from '../../bash-substitution/registry';
import { readIdentity } from './identity';
import { checkBashCommand } from './resource-command-match';

/**
 * The bash→tool substitution verdict (plan bash-to-tool-substitution-2026-07-26,
 * P-015), folded into this tool rather than given its own because the caller is
 * a PreToolUse gate that must learn EVERYTHING about a command in one
 * round-trip — a second verb would double the latency this hook adds to every
 * shell command on the box, for one more question about the same string.
 *
 * FAIL-OPEN AND STRICTLY ADDITIVE: any error returns no substitutions, and the
 * lock `decision` is never touched by this path. Existing consumers key on
 * `decision === 'block'` (see pretooluse-bash-resource-gate.sh), so a
 * substitution match must never be able to change that field — a registry row
 * about `cat` has nothing to say about whether a peer is mid-migration, and
 * conflating the two would let a routine advisory inherit a resource gate's
 * blocking power.
 */
async function substitutionVerdict(
  command: string,
  workspaceId: string,
): Promise<{ substitutions: SubstitutionMatch[]; substitutionTier: string | null }> {
  try {
    const rows = await getSubstitutionRows(workspaceId);
    const substitutions = matchCommandToSubstitutions(command, rows);
    return { substitutions, substitutionTier: strongestTier(substitutions) };
  } catch {
    return { substitutions: [], substitutionTier: null };
  }
}

export default defineTool({
  name: 'locks:check_command',
  description:
    'Full verdict for a raw shell command: (a) does it touch a named resource with an exclusive (restart/migration) in flight — decision (allow | warn | block) + matched resources; and (b) does a bash→tool substitution rule claim it — substitutions[] + substitutionTier (observe | advise | deny). The one call a raw-Bash gate makes.',
  guidance: {
    when: 'A hook (or you) wants to know, before running a command, whether it collides with an in-flight exclusive hold OR has a tool that should serve it instead.',
    notWhen: 'Acquiring a named-resource lock — use locks:acquire_resource. File edits — use locks:acquire.',
    chaining: 'block → wait / coordinate; warn → proceed with care; allow → run. substitutionTier advise → the command runs, but prefer the named tool next time; substitutions[].advisoryText is the text to surface.',
    seeAlso: [
      'locks:acquire_resource (take the exclusive hold the command needs)',
      'locks:queue (see who holds the conflicting lock)',
    ],
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    command: z.string().min(1).max(32000),
  }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readIdentity(ctx);
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();

    // Both questions about the same command, concurrently — the caller is a
    // gate on the hot path and the two reads are independent.
    const [verdict, substitution] = await Promise.all([
      checkBashCommand({ command: args.command, coordinationDomain, ownerId }),
      substitutionVerdict(args.command, workspaceId),
    ]);

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, ...verdict, ...substitution }) },
      ],
    };
  },
});
