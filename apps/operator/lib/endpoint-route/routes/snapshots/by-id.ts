/**
 * GET    /api/snapshots/:id  — detail (flat + nested manifest)
 * DELETE /api/snapshots/:id  — unlink tarball + .sha256 + .published.json
 *
 * Ported from app/api/snapshots/[id]/route.ts. `auth: 'public'` — flag-gated.
 */
import { promises as fs } from 'node:fs';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { findSnapshot } from '@/lib/snapshot-discovery';
import { withSnapshotLock } from '@/lib/snapshot-locks';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/snapshots/:id',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const id = ctx.params.id as string;
    const snap = await findSnapshot(id);
    if (!snap) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
    return Response.json({
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
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/snapshots/:id',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const id = ctx.params.id as string;
    return withSnapshotLock(id, async () => {
      const snap = await findSnapshot(id);
      if (!snap) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      await fs.unlink(snap.tarballPath);
      await fs.unlink(snap.tarballPath + '.sha256').catch(() => {});
      await fs.unlink(snap.tarballPath.replace(/\.tar\.gz$/, '.published.json')).catch(() => {});
      return Response.json({ ok: true });
    });
  },
});

export default [get, del];
