/**
 * PUT  /api/backups/destination — set destination config.
 *      Body: { type: 'local'|'local+s3'|'local+b2'|'local+rclone', config: object | null }
 *      Cleartext config is never echoed back; only `configured: bool` is.
 * POST /api/backups/destination/test — dry-run sync to verify connectivity.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

const S3Schema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  endpoint: z.string().optional(),
  region: z.string().optional(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
});
const B2Schema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  keyId: z.string().min(1),
  key: z.string().min(1),
});
const RcloneSchema = z.object({ remotePath: z.string().min(1) });

const Body = z.object({
  type: z.enum(['local', 'local+s3', 'local+b2', 'local+rclone']),
  config: z.union([S3Schema, B2Schema, RcloneSchema, z.null()]).optional(),
});

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const { type, config } = Body.parse(body);
    const wb = workspaceBackupFor(activeWorkspaceId());
    await wb.setDestination(type, config ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
