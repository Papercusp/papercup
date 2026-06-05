/**
 * POST /api/agent-mcp/provision — provision system:operator + system:oracle principals.
 * Ported from app/api/agent-mcp/provision/route.ts. `auth: 'public'`.
 */
import { provisionSystemPrincipal } from '@papercusp/agent-mcp/provisioning';
import { papercuspRoot } from '../../../papercusp-root';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const ORACLE_CAPS = [
  'tasks:read',
  'goals:read',
  'harness:read',
  'docs:read',
  'messages:read',
  'audit:read',
  'intel:read',
  'search:read',
  'messages:write',
];

const OPERATOR_CAPS = [
  ...ORACLE_CAPS,
  'tasks:write',
  'proposals:write',
  'goals:write',
  'routines:write',
  'chat:write',
];

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/provision',
  auth: 'public',
  async handler(req) {
    const { force } = (await req.json().catch(() => ({}))) as { force?: boolean };
    const workspaceId = activeWorkspaceId();
    const root = papercuspRoot();
    const provisioned: Array<{ name: string; rotated: boolean; configPath: string | null }> = [];
    for (const [name, caps] of [
      ['oracle', ORACLE_CAPS],
      ['operator', OPERATOR_CAPS],
    ] as const) {
      const r = await provisionSystemPrincipal({
        workspaceId,
        name,
        capabilities: caps,
        papercuspRoot: root,
        force,
      });
      if (r) {
        provisioned.push({ name: r.name, rotated: r.rotated, configPath: r.configPath });
      } else {
        provisioned.push({ name, rotated: false, configPath: null });
      }
    }
    return Response.json({ workspaceId, provisioned });
  },
});
