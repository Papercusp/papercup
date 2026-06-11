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
  // autoloop-pot-operator-rebuild-2026-06-05 P-004 — the Pot operator's
  // superpower + survey surface: harness:write gates blueprint:extend/create +
  // harness:create (create/manage harnesses from blueprints); the read/write
  // pairs cover the blackboard it surveys each wake (work_items frontier,
  // curation feed, activity bridge, coord, plans). Mirrored in
  // BLUEPRINT_ROLE_CAPS['operator'] (role-principal-caps.ts) because an
  // already-provisioned row keeps its old cap list (provision without force is
  // a no-op) — keep the two in sync.
  'harness:write',
  'work_items:read',
  'work_items:write',
  'curation:read',
  'activity:read',
  'coord:read',
  'coord:write',
  'plans:read',
];

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/provision',
  auth: 'loopback',
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
