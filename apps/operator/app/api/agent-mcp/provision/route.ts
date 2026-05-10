/**
 * POST /api/agent-mcp/provision
 *
 * One-time setup that provisions system:operator and system:oracle
 * principals for the active workspace. Idempotent — already-provisioned
 * principals are not rotated unless `force: true`.
 *
 * Request:  { force?: boolean }
 * Response: { workspaceId, provisioned: Array<{ name, rotated, configPath }> }
 */

import { NextRequest, NextResponse } from 'next/server';
import { provisionSystemPrincipal } from '@papercusp/agent-mcp/provisioning';
import { papercuspRoot } from '@/lib/papercusp-root';
import { activeWorkspaceId } from '@/lib/workspace-registry';

const ORACLE_CAPS = [
  'tasks:read',
  'goals:read',
  'harness:read',
  'messages:read',
  'audit:read',
  'intel:read',
  'hindsight:recall',
  'search:read',
  'messages:write',
];

const OPERATOR_CAPS = [
  ...ORACLE_CAPS,
  'tasks:write',
  'proposals:write',
  'goals:write',
  'routines:write',
];

export async function POST(req: NextRequest) {
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
  return NextResponse.json({ workspaceId, provisioned });
}
