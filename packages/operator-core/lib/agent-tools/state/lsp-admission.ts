/** State-plane lens over the daemon-owned admission queue; never an operator-local mirror. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { readLspDaemonAdmission } from '../../code-intelligence/lsp-daemon-client';
import type { LspAdmissionSnapshot } from '../../code-intelligence/lsp-admission';

export async function buildLspAdmissionStatePayload(
  workspaceId: string,
  read: (workspaceId: string) => Promise<LspAdmissionSnapshot> = readLspDaemonAdmission,
) {
  try {
    const admission = await read(workspaceId);
    if (admission.measured !== true || !Number.isFinite(admission.sampledAtMs) ||
        Math.abs(Date.now() - admission.sampledAtMs) > 30_000) throw new Error('daemon admission snapshot is unmeasured or stale');
    return { admission, assessment: admission.assessment, measurement: 'measured', unknown: [] as string[] };
  } catch (error) {
    return { admission: null, assessment: 'unknown', measurement: 'unknown',
      unknown: [`daemon-admission: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export default defineTool({
  name: 'lsp:admission_snapshot',
  description: 'Resolver for state:read lsp.admission; reads queue and feedback from the LSP daemon over its existing RPC transport.',
  guidance: {
    when: 'As the registered resolver for lsp.admission.',
    notWhen: 'To submit code-intelligence work or mutate the daemon.',
    chaining: 'Use state:read { cell:"lsp.admission" } for queue depth, fairness lanes, feedback and settlement failures.',
  },
  // @cell-lens lsp.admission
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({}),
  async handler(_args, ctx) {
    const payload = await buildLspAdmissionStatePayload(ctx.workspaceId ?? activeWorkspaceId());
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
