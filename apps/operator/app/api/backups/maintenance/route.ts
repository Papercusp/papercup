import { NextResponse } from 'next/server';
import { z } from 'zod';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

const Schema = z.object({ level: z.enum(['quick', 'full']).default('quick') });

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { level } = Schema.parse(body);
    const wb = workspaceBackupFor(activeWorkspaceId());
    await wb.maintenance(level);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
