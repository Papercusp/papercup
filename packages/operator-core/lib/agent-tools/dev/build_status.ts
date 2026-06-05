/**
 * dev:build_status — local-host build + service reachability check.
 *
 * Reads .next mtime, tails the prod log, and probes :3055 / :3070.
 * Used by the /dev right rail and the future Build block.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildStatus } from '../../dev-data';

export default defineTool({
  name: 'dev:build_status',
  profile: 'engineer',
  description: 'Local-host build mtime + bin/prod log tail + dev/prod server reachability.',
  capability: 'intel:read',
  guidance: {
    when: `Read recent build status from the dev panel — pass/fail per harness.`,
    notWhen: `For ONE harness's smoke tests, use harness-specific tools. dev:build_status is the cross-harness dev panel feed.`,
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z.object({}),
  async handler() {
    const result = await buildStatus();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
