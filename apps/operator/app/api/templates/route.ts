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

interface TemplateRow extends TemplateVersion {
  versions: { version: string; savedAtMs: number; publishedSlugs: TemplateVersion['publishedSlugs'] }[];
}

export async function GET() {
  const root = papercuspPath('templates');
  if (!existsSync(root)) return NextResponse.json({ templates: [] });

  const slugs = await fs.readdir(root, { withFileTypes: true });

  // Parallelize the per-slug × per-version manifest reads. Serial loops
  // pay ~150ms × N in Next.js dev (HMR file-tracking). See
  // /docs/performance #A1.
  const templates: TemplateRow[] = (
    await Promise.all(slugs.map(async (slug): Promise<TemplateRow | null> => {
      if (!slug.isDirectory()) return null;
      const slugDir = join(root, slug.name);
      const versions = await fs.readdir(slugDir, { withFileTypes: true });
      const collectedRaw = await Promise.all(versions.map(async (v): Promise<TemplateVersion | null> => {
        if (!v.isDirectory()) return null;
        const versionDir = join(slugDir, v.name);
        const manifestPath = join(versionDir, 'papercusp.json');
        if (!existsSync(manifestPath)) return null;
        try {
          const [stat, raw] = await Promise.all([
            fs.stat(versionDir),
            fs.readFile(manifestPath, 'utf8'),
          ]);
          const manifest = JSON.parse(raw) as Record<string, unknown>;
          const sidecar = join(versionDir, '.published.json');
          let published: TemplateVersion['publishedSlugs'] = [];
          if (existsSync(sidecar)) {
            try {
              const arr = JSON.parse(await fs.readFile(sidecar, 'utf8'));
              if (Array.isArray(arr)) published = arr;
            } catch { /* malformed sidecar, ignore */ }
          }
          return {
            slug: slug.name,
            version: v.name,
            path: versionDir,
            manifest,
            publishedSlugs: published,
            savedAtMs: stat.mtimeMs,
          };
        } catch {
          return null;
        }
      }));
      const collected = collectedRaw.filter((c): c is TemplateVersion => c != null);
      if (collected.length === 0) return null;
      collected.sort((a, b) => b.savedAtMs - a.savedAtMs);
      const newest = collected[0]!;
      return {
        ...newest,
        versions: collected.map((v) => ({
          version: v.version,
          savedAtMs: v.savedAtMs,
          publishedSlugs: v.publishedSlugs,
        })),
      };
    }))
  ).filter((t): t is TemplateRow => t != null);

  templates.sort((a, b) => b.savedAtMs - a.savedAtMs);
  return NextResponse.json({ templates });
}
