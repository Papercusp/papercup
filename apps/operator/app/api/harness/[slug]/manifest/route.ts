import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

import { papercuspPath } from '@/lib/papercusp-root';
import { loadHarnessRegistry } from '@/lib/harness-registry';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/harness/:slug/manifest — returns the harness instance's
 * `papercusp.json` (the file copied from the template at init time).
 * Used by SpecEditor to discover the template-declared `configFiles`
 * list so the file-tab strip is template-driven, not hardcoded.
 *
 * Bypasses the Hono catch-all (consistent with /api/harness/projects
 * and /api/plugins/global) so the endpoint is fast under HMR churn.
 */

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ error: 'invalid slug' }, { status: 400 });
  }
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: 'unknown project' }, { status: 404 });

  // The instance manifest is the template's `papercusp.json` copied to
  // the project's `.harness/papercusp.json` at init. Fall back to the
  // template directory's manifest if the project doesn't have its own
  // copy yet (legacy harnesses).
  const projectManifestPath = join(project.path, '.harness', 'papercusp.json');
  let manifest: Record<string, unknown> | null = null;
  if (existsSync(projectManifestPath)) {
    try { manifest = JSON.parse(await fs.readFile(projectManifestPath, 'utf8')); } catch { /* ignore */ }
  }
  // Try the installed-template manifest if the harness was created
  // from one (legacy harnesses without their own copy).
  if (!manifest) {
    // Walk every installed harness template's manifest and match against
    // this project's harness_kind or registered template — best-effort.
    // Parallel-then-find-first; see /docs/performance #A1 (~70-entry dir).
    const harnessesDir = papercuspPath('harnesses');
    if (existsSync(harnessesDir)) {
      const dirs = await fs.readdir(harnessesDir, { withFileTypes: true }).catch(() => []);
      const candidates = await Promise.all(dirs.map(async (d) => {
        if (!d.isDirectory()) return null;
        try {
          const m = JSON.parse(await fs.readFile(join(harnessesDir, d.name, 'papercusp.json'), 'utf8'));
          return m && Array.isArray(m.configFiles) ? m : null;
        } catch {
          return null;
        }
      }));
      const found = candidates.find((m) => m != null);
      if (found) manifest = found;
    }
  }

  return NextResponse.json({
    slug,
    projectPath: project.path,
    manifest,
    configFiles: Array.isArray(manifest?.configFiles) ? manifest!.configFiles : null,
  });
}
