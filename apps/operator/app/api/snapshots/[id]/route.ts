import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { findSnapshot } from '@/lib/snapshot-discovery';
import { withSnapshotLock } from '@/lib/snapshot-locks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
  if (blocked) return blocked;
  const { id } = await params;
  const snap = await findSnapshot(id);
  if (!snap) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  // Detail response intentionally serves both shapes:
  //   - flat top-level fields (id/harnessSlug/bytes/createdAtMs/name/...)
  //     that mirror the list endpoint, so callers can use either
  //     interchangeably.
  //   - nested `manifest` with the full files[]/excluded[]/plugins[]
  //     arrays that the list endpoint omits as derived counts.
  return NextResponse.json({
    ok: true,
    snapshot: {
      id: snap.id,
      harnessSlug: snap.harnessSlug,
      bytes: snap.bytes,
      createdAtMs: snap.createdAtMs,
      tarballPath: snap.tarballPath,
      name: snap.manifest.name,
      description: snap.manifest.description ?? null,
      template: snap.manifest.template,
      filesCount: snap.manifest.files.length,
      excludedCount: snap.manifest.excluded.length,
      pluginsCount: snap.manifest.plugins.length,
      partial: snap.manifest.partial,
      license: snap.manifest.license,
      redactions: snap.manifest.redactions,
      publishes: snap.publishes,
      manifest: snap.manifest,
    },
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
  if (blocked) return blocked;
  const { id } = await params;
  return withSnapshotLock(id, async () => {
    // Re-resolve inside the lock — a concurrent Instantiate may have
    // finished consuming the tarball, but the file should still be on
    // disk regardless.
    const snap = await findSnapshot(id);
    if (!snap) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    await fs.unlink(snap.tarballPath);
    await fs.unlink(snap.tarballPath + '.sha256').catch(() => {});
    await fs.unlink(snap.tarballPath.replace(/\.tar\.gz$/, '.published.json')).catch(() => {});
    return NextResponse.json({ ok: true });
  });
}
