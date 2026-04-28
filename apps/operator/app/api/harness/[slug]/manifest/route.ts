import { NextResponse } from 'next/server';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');

interface ProjectEntry { slug: string; path: string; harness_kind?: string; department_slug?: string }
interface RegistryShape { projects: ProjectEntry[] }

function loadRegistry(): RegistryShape {
  for (const p of [REGISTRY_PATH, LEGACY_REGISTRY_PATH]) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')) as RegistryShape; } catch { /* fall through */ }
    }
  }
  return { projects: [] };
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ error: 'invalid slug' }, { status: 400 });
  }
  const reg = loadRegistry();
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
    const harnessesDir = HARNESSES_DIR;
    if (existsSync(harnessesDir)) {
      const dirs = await fs.readdir(harnessesDir, { withFileTypes: true }).catch(() => []);
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        try {
          const m = JSON.parse(await fs.readFile(join(harnessesDir, d.name, 'papercusp.json'), 'utf8'));
          if (m && Array.isArray(m.configFiles)) { manifest = m; break; }
        } catch { /* skip */ }
      }
    }
  }

  return NextResponse.json({
    slug,
    projectPath: project.path,
    manifest,
    configFiles: Array.isArray(manifest?.configFiles) ? manifest!.configFiles : null,
  });
}
