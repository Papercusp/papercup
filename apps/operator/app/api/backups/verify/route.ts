import { NextResponse } from 'next/server';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const result = await wb.verify();
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
