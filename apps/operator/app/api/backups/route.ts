/**
 * GET /api/backups  — { settings, stats } for the active workspace.
 * PUT /api/backups  — replace settings (full body, validated).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

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

export async function GET() {
  try {
    const ws = activeWorkspaceId();
    const wb = workspaceBackupFor(ws);
    const [settings, stats] = await Promise.all([wb.getSettings(), wb.stats()]);
    return NextResponse.json({ workspaceId: ws, settings, stats });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const parsed = SettingsSchema.parse(body);
    const wb = workspaceBackupFor(activeWorkspaceId());
    const next = await wb.updateSettings(parsed);
    return NextResponse.json({ settings: next });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
