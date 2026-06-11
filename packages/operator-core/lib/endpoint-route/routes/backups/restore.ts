/**
 * POST /api/backups/restore — restore-to-clone (or in_place with safety snap).
 *
 * Ported from app/api/backups/restore/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { workspaceBackupFor } from '../../../backup';
import { durableRestoreInPlace } from '../../../backup/durable-ops';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const Schema = z.object({
  kopiaSnapshotId: z.string().min(1),
  source: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  mode: z.enum(['clone', 'in_place']).default('clone'),
});

export default defineTool({
  method: 'POST',
  path: '/backups/restore',
  auth: 'loopback',
  async handler(req) {
    try {
      const body = await req.json();
      const args = Schema.parse(body);
      const ws = activeWorkspaceId();
      if (args.mode === 'in_place') {
        const result = await durableRestoreInPlace(ws, {
          kopiaSnapshotId: args.kopiaSnapshotId,
          target: args.target,
        });
        return Response.json({ result });
      }
      const result = await workspaceBackupFor(ws).restoreToClone(args);
      return Response.json({ result });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
