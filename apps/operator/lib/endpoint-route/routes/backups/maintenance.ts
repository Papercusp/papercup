/**
 * POST /api/backups/maintenance — kopia maintenance run.
 *
 * Ported from app/api/backups/maintenance/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { defineRoute } from '../../define-route';

const Schema = z.object({ level: z.enum(['quick', 'full']).default('quick') });

export default defineRoute({
  method: 'POST',
  path: '/backups/maintenance',
  auth: 'public',
  async handler(req) {
    try {
      const body = await req.json().catch(() => ({}));
      const { level } = Schema.parse(body);
      const wb = workspaceBackupFor(activeWorkspaceId());
      const args = level === 'full' ? ['maintenance', 'run', '--full'] : ['maintenance', 'run'];
      const trace = await wb.kopiaTraced(args);
      return Response.json({ ok: trace.exitCode === 0, trace });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
