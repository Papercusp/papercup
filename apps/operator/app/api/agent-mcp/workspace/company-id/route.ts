/**
 * GET/PUT /api/agent-mcp/workspace/company-id
 *
 * Workspace's Paperclip companyId for Hindsight bank derivation.
 * Bank format: paperclip::<companyId>; null = degraded.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  activeWorkspaceId,
  setCompanyId,
  companyIdFor,
} from '@/lib/workspace-registry';

export async function PUT(req: NextRequest) {
  const { companyId } = (await req.json()) as { companyId: string | null };
  const workspaceId = activeWorkspaceId();
  setCompanyId(workspaceId, companyId);
  return NextResponse.json({ workspaceId, companyId });
}

export async function GET() {
  const workspaceId = activeWorkspaceId();
  return NextResponse.json({
    workspaceId,
    companyId: companyIdFor(workspaceId),
  });
}
