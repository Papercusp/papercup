/**
 * DELETE /api/templates/<slug>/<version>
 *
 * Removes a saved template directory under ~/.papercusp/templates/.
 * Best-effort — if a template has been published to the marketplace,
 * this only removes the local copy; the published version stays live
 * until retracted via the marketplace API.
 */

import { NextResponse } from 'next/server';
import { existsSync, promises as fs } from 'node:fs';
import { papercuspPath } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ slug: string; version: string }> },
) {
  const { slug, version } = await ctx.params;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ ok: false, error: 'invalid slug' }, { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version)) {
    return NextResponse.json({ ok: false, error: 'invalid version' }, { status: 400 });
  }
  const dir = papercuspPath('templates', slug, version);
  if (!existsSync(dir)) {
    return NextResponse.json({ ok: false, error: 'template not found' }, { status: 404 });
  }
  await fs.rm(dir, { recursive: true, force: true });

  // Also remove the parent slug dir if it's now empty (no other versions
  // hanging around). Failure is fine — leaks an empty dir, no harm.
  try {
    const parent = papercuspPath('templates', slug);
    const remaining = await fs.readdir(parent);
    if (remaining.length === 0) await fs.rmdir(parent);
  } catch { /* ignore */ }

  return NextResponse.json({ ok: true, slug, version });
}
