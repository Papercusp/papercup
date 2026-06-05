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
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { checkBashCommand } from './resource-command-match';

const SU_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'locks:check_command',
  description:
    'Check a raw shell command against the named-lock registry: does it touch a resource with an exclusive (restart/migration) in flight? Returns decision (allow | warn | block) + the matched resources. The verdict a raw-Bash gate consumes.',
  guidance: {
    when: 'A hook (or you) wants to know if a destructive command would collide with an in-flight exclusive hold before running it.',
    notWhen: 'Acquiring a lock — use locks:acquire_resource. File edits — locks:queue.',
    chaining: 'block → wait / coordinate; warn → proceed with care; allow → run.',
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    command: z.string().min(1).max(4000),
  }),
  async handler(args, ctx) {
    const { ownerId, coordinationDomain } = readIdentity(ctx);
    const verdict = await checkBashCommand({
      command: args.command,
      coordinationDomain,
      ownerId,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...verdict }) }],
    };
  },
});
