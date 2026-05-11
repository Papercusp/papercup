/**
 * GET /api/backups/broken-list — list .broken-<ts>-<name>/ dirs in the
 * active workspace, so the UI can offer rollback for recent promotions.
 */
import { NextResponse } from 'next/server';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const root = join(homedir(), '.papercusp-workspaces', activeWorkspaceId());
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const broken: { path: string; createdAt: string; sizeMb: number | null }[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('.broken-')) continue;
      const full = join(root, e.name);
      const s = await stat(full).catch(() => null);
      broken.push({
        path: full,
        createdAt: s?.mtime.toISOString() ?? new Date(0).toISOString(),
        sizeMb: null, // expensive to compute, skip for the list view
      });
    }
    broken.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return NextResponse.json({ broken });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
