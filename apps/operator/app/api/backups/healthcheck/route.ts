/**
 * GET /api/backups/healthcheck — UI banner data.
 *  - state: 'ok' | 'stale' | 'failing' | 'disabled' | 'never_run'
 *  - lastOkAt, lastFailureAt, ageSeconds
 *  - freeDiskBytes for the backup destination (drive containing the repo)
 */
import { NextResponse } from 'next/server';
import { statfs } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { workspaceBackupFor } from '@/lib/backup';
import { getKopiaDetection } from '@/lib/backup/scheduler';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

const statfsP = promisify(statfs);

const STALE_THRESHOLD_SEC = 30 * 60; // 30 min — matches host setup

export async function GET() {
  try {
    const ws = activeWorkspaceId();
    const wb = workspaceBackupFor(ws);
    const [settings, stats] = await Promise.all([wb.getSettings(), wb.stats()]);

    let state: 'ok' | 'stale' | 'failing' | 'disabled' | 'never_run' = 'ok';
    let ageSeconds: number | null = null;
    if (!settings.enabled) state = 'disabled';
    else if (!stats.lastSnapshotAt) state = 'never_run';
    else {
      ageSeconds = Math.round((Date.now() - new Date(stats.lastSnapshotAt).getTime()) / 1000);
      if (ageSeconds > STALE_THRESHOLD_SEC) state = 'stale';
      if (stats.lastFailureAt && new Date(stats.lastFailureAt) > new Date(stats.lastSnapshotAt)) {
        state = 'failing';
      }
    }

    let freeDiskBytes: number | null = null;
    try {
      const fs = await statfsP(join(homedir(), '.papercusp-workspaces'));
      freeDiskBytes = Number(fs.bavail) * fs.bsize;
    } catch { /* drive query optional */ }

    const kopia = getKopiaDetection();
    if (!kopia.ok) state = 'failing';

    return NextResponse.json({
      state,
      ageSeconds,
      lastOkAt: stats.lastSnapshotAt,
      lastFailureAt: stats.lastFailureAt,
      freeDiskBytes,
      staleThresholdSec: STALE_THRESHOLD_SEC,
      kopia,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
