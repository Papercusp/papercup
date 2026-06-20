/**
 * POST /api/agent-mcp/provision — provision system:operator + system:oracle principals.
 * Ported from app/api/agent-mcp/provision/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
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
  // EI-2048 (owner-fix 2026-06-20): the operator/psu principal had NO memory
  // caps, so a psu-launched SU session (role=operator) hit `missing_capability:
  // … lacks capability "memory:write"` on memory:remember/forget/update/search —
  // the same omission class as the `plans:write` gap. The `bee` role already
  // carries these (role-principal-caps.ts, "psu engineering parity"); the
  // operator never did. Grant them so the role=operator MCP surface can curate
  // memory. (NB: re-provision with force — or a deploy — is needed for the live
  // system_principals row to pick this up; auth.ts loadCapabilities reads the DB
  // row, and provision-without-force is a no-op for an existing row.)
  'memory:read',
  'memory:write',
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
