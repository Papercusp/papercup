import { NextResponse } from 'next/server';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const trace = await wb.kopiaTraced(['snapshot', 'verify']);
    return NextResponse.json({
      result: { ok: trace.exitCode === 0, errors: trace.exitCode === 0 ? [] : [trace.stderr] },
      trace,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
