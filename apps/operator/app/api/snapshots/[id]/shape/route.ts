/**
 * GET /api/snapshots/[id]/shape
 *
 * Returns each plugin's `.shape` (per-field share-semantics descriptor)
 * extracted from the snapshot manifest. The fork-completion UI uses
 * this to render prompts for stripped fields (`shareable: false`,
 * `secret: true`) and "Connect with X" buttons for `oauth` fields.
 *
 * Spec: /docs/snapshots/share-semantics.
 */

import { NextResponse } from 'next/server';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import {
  readManifestFromTarball,
  effectiveVersionPin,
  type SnapshotPlugin,
  type SnapshotVersionPin,
} from '@papercusp/export-state';
import { findSnapshot } from '@/lib/snapshot-discovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PluginManifestEntry {
  name: string;
  version: string;
  capabilities?: string[];
  configJson?: string;
  shapeJson?: string;
  pluginVersionPinned?: boolean;
  versionPin?: SnapshotVersionPin;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
  if (blocked) return blocked;
  const { id } = await params;
  const snap = await findSnapshot(id);
  if (!snap) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  // Read the manifest directly from the tarball — works for any snapshot
  // including ones already published before V1 (those will have empty
  // shape data and the UI just falls through with no prompts).
  let manifestPlugins: PluginManifestEntry[] = [];
  try {
    const m = await readManifestFromTarball(snap.tarballPath);
    manifestPlugins = (m.plugins ?? []) as PluginManifestEntry[];
  } catch (e: unknown) {
    return NextResponse.json(
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
      // Back-compat for UI consumers that haven't migrated yet — both
      // are advisory; new readers should use versionPin.
      pluginVersionPinned: vp.mode === 'exact',
      shape,
      preservedConfig: config,
    };
  });

  return NextResponse.json({ ok: true, plugins });
}
