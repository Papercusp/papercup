/**
 * GET /api/templates
 *
 * Lists templates saved by the harness "Save template" flow into
 * `~/.papercusp/templates/<slug>/<version>/`. Each entry is the latest
 * version per slug (newest first), with the parsed papercusp.json so the
 * UI can render plugin/model summaries without a second fetch.
 */

import { NextResponse } from 'next/server';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TemplateVersion {
  slug: string;
  version: string;
  path: string;
  manifest: Record<string, unknown>;
  publishedSlugs: { slug: string; version: string; browseUrl?: string; publishedAtMs?: number }[];
  savedAtMs: number;
}

export async function GET() {
  const root = papercuspPath('templates');
  if (!existsSync(root)) return NextResponse.json({ templates: [] });

  const slugs = await fs.readdir(root, { withFileTypes: true });
  const templates: TemplateVersion[] = [];

  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(root, slug.name);
    const versions = await fs.readdir(slugDir, { withFileTypes: true });
    let newest: TemplateVersion | null = null;
    for (const v of versions) {
      if (!v.isDirectory()) continue;
      const versionDir = join(slugDir, v.name);
      const manifestPath = join(versionDir, 'papercusp.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const stat = await fs.stat(versionDir);
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as Record<string, unknown>;

        // Read the publish sidecar if it exists, so the UI can show
        // marketplace coordinates + skip "Publish" for already-published
        // templates.
        const sidecar = join(versionDir, '.published.json');
        let published: TemplateVersion['publishedSlugs'] = [];
        if (existsSync(sidecar)) {
          try {
            const arr = JSON.parse(await fs.readFile(sidecar, 'utf8'));
            if (Array.isArray(arr)) published = arr;
          } catch { /* malformed sidecar, ignore */ }
        }

        const candidate: TemplateVersion = {
          slug: slug.name,
          version: v.name,
          path: versionDir,
          manifest,
          publishedSlugs: published,
          savedAtMs: stat.mtimeMs,
        };
        if (!newest || candidate.savedAtMs > newest.savedAtMs) newest = candidate;
      } catch {
        // Skip malformed templates rather than failing the whole listing.
      }
    }
    if (newest) templates.push(newest);
  }

  templates.sort((a, b) => b.savedAtMs - a.savedAtMs);
  return NextResponse.json({ templates });
}
