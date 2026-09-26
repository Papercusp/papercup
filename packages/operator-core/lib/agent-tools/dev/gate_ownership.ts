/** A bounded gate-ownership read independent of the full git pipeline probe. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readGateOwnership } from '../../coord/gate-ownership';

export default defineTool({
  name: 'dev:gate_ownership',
  profile: 'engineer',
  description: 'Read the green-checkpoint incident owner and holder liveness without running git or release-position probes.',
  capability: 'intel:read',
  guidance: {
    when: 'When deciding who owns a red or stalled green-checkpoint incident.',
    notWhen: 'To locate a particular edit in staging, main, or the deployed operator; use dev:pipeline_position.',
  },
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [
    'operator', 'mug', 'architect', 'worker', 'scoper', 'validator', 'reviewer',
    'debugger', 'documenter', 'curator', 'cup', 'papercup', 'papercup-deep', 'kettle',
    'release-fixer', 'merge-resolver', 'content-fixer', 'release-manager',
  ],
  args: z.object({}),
  async handler(_args, ctx) {
    const ownership = await readGateOwnership({ harness: ctx.harnessSlug ?? undefined });
    return {
      data: {
        gate: { ownership },
        assessments: { gateOwnership: ownership.assessment },
      },
    };
  },
});
