/**
 * GET /api/backups/healthcheck — UI banner data.
 *
 * Ported from app/api/backups/healthcheck/route.ts. `auth: 'public'`.
 */
import { statfs } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { workspaceBackupFor } from '../../../backup';
import { getKopiaDetection } from '../../../backup/scheduler';
import { activeWorkspaceId, workspacesRoot } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const statfsP = promisify(statfs);
const STALE_THRESHOLD_SEC = 30 * 60;

export default defineTool({
  method: 'GET',
  path: '/backups/healthcheck',
  auth: 'public',
  async handler() {
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
        const fs = await statfsP(workspacesRoot());
        freeDiskBytes = Number(fs.bavail) * fs.bsize;
      } catch { /* optional */ }

      const kopia = getKopiaDetection();
      if (!kopia.ok) state = 'failing';

      return Response.json({
        state,
        ageSeconds,
        lastOkAt: stats.lastSnapshotAt,
        lastFailureAt: stats.lastFailureAt,
        freeDiskBytes,
        staleThresholdSec: STALE_THRESHOLD_SEC,
        kopia,
      });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
