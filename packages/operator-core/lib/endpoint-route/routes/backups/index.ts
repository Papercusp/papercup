/**
 * GET /api/backups  — { settings, stats } for active workspace.
 * PUT /api/backups  — replace settings (validated).
 *
 * Ported from app/api/backups/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { workspaceBackupFor } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const RetentionSchema = z.object({
  keepLatest: z.number().int().min(1),
  keepHourly: z.number().int().min(0),
  keepDaily: z.number().int().min(0),
  keepWeekly: z.number().int().min(0),
  keepMonthly: z.number().int().min(0),
});

const SettingsSchema = z.object({
  enabled: z.boolean(),
  cadenceMode: z.enum(['event', 'interval', 'both']),
  cadenceMinutes: z.number().int().min(1).max(1440),
  retentionPreset: z.enum(['aggressive', 'default', 'conservative', 'custom']),
  retentionCustom: RetentionSchema.nullable(),
  eventTriggers: z.array(z.enum([
    'manual', 'interval', 'pre_destructive', 'post_run',
    'plugin_install', 'secret_change', 'startup',
  ])),
  excludedPaths: z.array(z.string()),
});

const get = defineTool({
  method: 'GET',
  path: '/backups',
  auth: 'public',
  async handler() {
    try {
      const ws = activeWorkspaceId();
      const wb = workspaceBackupFor(ws);
      const [settings, stats, kopiaStats] = await Promise.all([
        wb.getSettings(),
        wb.stats(),
        wb.kopiaContentStats().catch(() => null),
      ]);
      const merged = kopiaStats
        ? {
            ...stats,
            bytesOnDisk: kopiaStats.totalSize,
            dedupRatio: stats.bytesRaw === 0 ? 0 : Math.max(0, 1 - kopiaStats.totalSize / stats.bytesRaw),
          }
        : stats;
      return Response.json({ workspaceId: ws, settings, stats: merged });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/backups',
  auth: 'loopback',
  async handler(req) {
    try {
      const body = await req.json();
      const parsed = SettingsSchema.parse(body);
      const wb = workspaceBackupFor(activeWorkspaceId());
      const next = await wb.updateSettings(parsed);
      return Response.json({ settings: next });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
    }
  },
});

export default [get, put];
