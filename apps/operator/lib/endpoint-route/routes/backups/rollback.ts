/**
 * POST /api/backups/rollback — undo a previous promote.
 *
 * Ported from app/api/backups/rollback/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const Schema = z.object({ brokenPath: z.string().min(1) });

export default defineTool({
  method: 'POST',
  path: '/backups/rollback',
  auth: 'public',
  async handler(req) {
    try {
      const body = await req.json();
      const args = Schema.parse(body);
      const wb = workspaceBackupFor(activeWorkspaceId());
      const result = await wb.rollbackPromote(args);
      return Response.json({ result });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
