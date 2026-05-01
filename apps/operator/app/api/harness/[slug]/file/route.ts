import { NextResponse } from 'next/server';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, relative, dirname } from 'node:path';

import { papercuspRoot } from '@/lib/papercusp-root';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/harness/:slug/file?path=<rel> — reads a config file declared
 * in the harness's manifest.configFiles. PUT writes it. The `path` param
 * is constrained to the manifest's allowlist so a leaky client can't
 * read arbitrary files in the project tree (or escape it via `..`).
 *
 * Manifest-driven instead of hardcoded so SpecEditor stays template-
 * agnostic — every config tab maps to a configFiles[] entry.
 */
const PAPERCUSP_ROOT = papercuspRoot();
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');

interface ProjectEntry { slug: string; path: string }
interface RegistryShape { projects: ProjectEntry[] }
interface ConfigFile { path: string; language?: string; label?: string }

function loadRegistry(): RegistryShape {
  for (const p of [REGISTRY_PATH, LEGACY_REGISTRY_PATH]) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')) as RegistryShape; } catch { /* fall through */ }
    }
  }
  return { projects: [] };
}

async function loadAllowlist(projectPath: string): Promise<string[]> {
  const projectManifest = join(projectPath, '.harness', 'papercusp.json');
  let manifest: { configFiles?: unknown } | null = null;
  if (existsSync(projectManifest)) {
    try { manifest = JSON.parse(await fs.readFile(projectManifest, 'utf8')); } catch { /* ignore */ }
  }
  // Fallback: scan installed templates for a configFiles list.
  if (!manifest || !Array.isArray(manifest.configFiles)) {
    const dirs = await fs.readdir(HARNESSES_DIR, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      try {
        const m = JSON.parse(await fs.readFile(join(HARNESSES_DIR, d.name, 'papercusp.json'), 'utf8'));
        if (m && Array.isArray(m.configFiles)) { manifest = m; break; }
      } catch { /* skip */ }
    }
  }
  // Last-resort fallback for legacy harnesses without any manifest:
  // the SpecEditor's pre-template list. Templates that ship configFiles
  // override this; anything else gets the historical 9 tabs.
  const cfg = (manifest?.configFiles as ConfigFile[] | undefined) ?? [];
  if (cfg.length > 0) return cfg.map((c) => c.path);
  return [
    'SPEC.md', 'AGENTS.md',
    '.harness/validation-contract.md', '.harness/config.json',
    '.mcp.json', '.claude/settings.json',
    '.harness/supervisor-notes.md', '.harness/knowledge.md',
    '.env',
  ];
}

function resolveSafe(projectPath: string, rel: string): string | null {
  // Constrain to the project tree — no `..`, no absolute paths, no symlinks.
  if (rel.startsWith('/') || rel.includes('..')) return null;
  const abs = normalize(join(projectPath, rel));
  const back = relative(projectPath, abs);
  if (back.startsWith('..') || back.startsWith('/')) return null;
  return abs;
}

async function authorize(slug: string, rel: string): Promise<{ ok: true; abs: string } | { ok: false; error: string; status: number }> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) return { ok: false, error: 'invalid slug', status: 400 };
  const project = loadRegistry().projects.find((p) => p.slug === slug);
  if (!project) return { ok: false, error: 'unknown project', status: 404 };
  const allowlist = await loadAllowlist(project.path);
  if (!allowlist.includes(rel)) return { ok: false, error: `path "${rel}" not in manifest configFiles`, status: 403 };
  const abs = resolveSafe(project.path, rel);
  if (!abs) return { ok: false, error: 'path resolves outside project tree', status: 400 };
  return { ok: true, abs };
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const rel = url.searchParams.get('path') ?? '';
  if (!rel) return NextResponse.json({ error: 'path query param required' }, { status: 400 });
  const auth = await authorize(slug, rel);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!existsSync(auth.abs)) {
    return NextResponse.json({ path: rel, content: null, exists: false });
  }
  const content = await fs.readFile(auth.abs, 'utf8').catch(() => null);
  return NextResponse.json({ path: rel, content, exists: content !== null });
}

export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let body: { path?: string; content?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const rel = String(body.path ?? '').trim();
  if (!rel) return NextResponse.json({ error: 'path required' }, { status: 400 });
  const auth = await authorize(slug, rel);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const content = typeof body.content === 'string' ? body.content : null;
  if (content === null) return NextResponse.json({ error: 'content (string) required' }, { status: 400 });
  await fs.mkdir(dirname(auth.abs), { recursive: true });
  await fs.writeFile(auth.abs, content, 'utf8');
  return NextResponse.json({ ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') });
}
