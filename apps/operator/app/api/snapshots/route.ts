import { NextResponse } from 'next/server';
import { listAllSnapshots } from '@/lib/snapshot-discovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const all = await listAllSnapshots();
  return NextResponse.json({
    snapshots: all.map((s) => ({
      id: s.id,
      harnessSlug: s.harnessSlug,
      bytes: s.bytes,
      createdAtMs: s.createdAtMs,
      name: s.manifest.name,
      description: s.manifest.description ?? null,
      template: s.manifest.template,
      filesCount: s.manifest.files.length,
      excludedCount: s.manifest.excluded.length,
      pluginsCount: s.manifest.plugins.length,
      partial: s.manifest.partial,
      license: s.manifest.license,
      redactions: s.manifest.redactions,
      publishes: s.publishes,
    })),
  });
}
