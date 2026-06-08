/**
 * dev:processes — inventory of agent-related processes on this host.
 *
 * Walks /proc, classifies cmdlines (run.sh, omp, claude, paperclip, pty,
 * next), maps each cwd to a harness slug + workspace if possible.
 * Read-only; kill is design-blocked behind Tier 1 capability work.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listProcesses } from '../../dev-data';

const KIND_ENUM = ['run.sh', 'omp', 'claude', 'paperclip', 'pty', 'next'] as const;

export default defineTool({
  name: 'dev:processes',
  profile: 'engineer',
  description: 'Inventory of agent-related processes on this host (run.sh, omp, claude, paperclip, pty, next) with cmdline, cwd, and inferred harness/workspace.',
  capability: 'intel:read',
  guidance: {
    when: `List tracked processes (delegates, plugin subprocesses, orchestrator children) for the /dev panel.`,
    notWhen: `For ACTIVE spawns, use \`orchestrator.list_active\`. For delegates, use \`delegates:list\`. dev:processes is the unified diagnostic view.`,
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'bee'],
  args: z.object({
    kinds: z.array(z.enum(KIND_ENUM)).optional(),
  }),
  async handler(args) {
    const result = await listProcesses({ kinds: args.kinds });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: result.processes.length, processes: result.processes }),
        },
      ],
    };
  },
});
