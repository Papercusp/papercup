/**
 * GET /api/snapshots/:id/shape
 *
 * Each plugin's `.shape` extracted from the snapshot manifest.
 *
 * Ported from app/api/snapshots/[id]/shape/route.ts. `auth: 'public'` — flag-gated.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import {
  readManifestFromTarball,
  effectiveVersionPin,
  type SnapshotPlugin,
  type SnapshotVersionPin,
} from '@papercusp/export-state';
import { findSnapshot } from '../../../snapshot-discovery';
import { defineTool } from '@papercusp/agent-mcp';

interface PluginManifestEntry {
  name: string;
  version: string;
  capabilities?: string[];
  configJson?: string;
  shapeJson?: string;
  pluginVersionPinned?: boolean;
  versionPin?: SnapshotVersionPin;
}

export default defineTool({
  method: 'GET',
  path: '/snapshots/:id/shape',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const id = ctx.params.id as string;
    const snap = await findSnapshot(id);
    if (!snap) return Response.json({ ok: false, error: 'not found' }, { status: 404 });

    let manifestPlugins: PluginManifestEntry[] = [];
    try {
      const m = await readManifestFromTarball(snap.tarballPath);
      manifestPlugins = (m.plugins ?? []) as PluginManifestEntry[];
    } catch (e: unknown) {
      return Response.json(
        { ok: false, error: `read manifest failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }

    const plugins = manifestPlugins.map((p) => {
      let shape: unknown = null;
      if (p.shapeJson) {
        try { shape = JSON.parse(p.shapeJson); } catch { /* skip */ }
      }
      let config: unknown = null;
      if (p.configJson) {
        try { config = JSON.parse(p.configJson); } catch { /* skip */ }
      }
      const vp = effectiveVersionPin(p as SnapshotPlugin);
      return {
        name: p.name,
        version: p.version,
        versionPin: vp,
        pluginVersionPinned: vp.mode === 'exact',
        shape,
        preservedConfig: config,
      };
    });

    return Response.json({ ok: true, plugins });
  },
});
