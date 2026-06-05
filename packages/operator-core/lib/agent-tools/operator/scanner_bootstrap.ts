/**
 * operator:scanner_bootstrap — build the scanner's bootstrap blob
 * (prior scan summary + workspace cues) without actually starting a
 * scan. Useful for debug + reuse from external scanner harnesses.
 *
 * `workspaceId` defaults to the active workspace; pass an explicit id
 * to inspect another workspace's bootstrap.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildScannerBootstrap } from '../../operator-scanner-bootstrap';
import { activeWorkspaceId } from '../../workspace-registry';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'operator:scanner_bootstrap',
  profile: 'engineer',
  description: 'Build the scanner bootstrap blob (prior-scan summary + workspace cues) without starting a scan.',
  capability: 'operator:read',
  guidance: {
    when: `Initialize the operator scanner's state on first install or after \`scanner_reset\`. Idempotent.`,
    notWhen: `For TRIGGERING a scan, the scanner runs on its own cadence — there's no manual trigger here.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    workspaceId: z.string().optional(),
    maxPriorSummaryChars: z.number().int().positive().optional(),
  }),
  async handler(args) {
    const wsid = args.workspaceId ?? activeWorkspaceId();
    const blob = await buildScannerBootstrap({
      workspaceId: wsid,
      maxPriorSummaryChars: args.maxPriorSummaryChars,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ workspaceId: wsid, bootstrap: blob }) }] };
  },
});
