/**
 * GET/PUT /api/templates/<slug>/<version>/file?path=<rel>
 *
 * Reads / writes a single file inside a saved template directory at
 * ~/.papercusp/templates/<slug>/<version>/. The path is allowlisted to:
 *   - the manifest's configFiles[] declarations
 *   - papercusp.json itself (so the editor can update plugin lists, models)
 *   - README.md
 * Anything else is rejected to keep the editor from leaking arbitrary FS
 * reads through a saved-template surface.
 */

import { NextResponse } from 'next/server';
import { existsSync, promises as fs } from 'node:fs';
import { join, normalize, relative, dirname } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ConfigFile { path: string }

async function loadAllowlist(dir: string): Promise<string[]> {
  const allowed = new Set<string>(['papercusp.json', 'README.md']);
  const manifestPath = join(dir, 'papercusp.json');
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { configFiles?: ConfigFile[] };
      if (Array.isArray(m.configFiles)) {
        for (const cf of m.configFiles) {
          if (cf?.path && typeof cf.path === 'string') allowed.add(cf.path);
        }
      }
    } catch { /* malformed manifest — only the defaults stay */ }
  }
  return Array.from(allowed);
}

function resolveSafe(root: string, rel: string): string | null {
  if (rel.startsWith('/') || rel.includes('..')) return null;
  const abs = normalize(join(root, rel));
  const back = relative(root, abs);
  if (back.startsWith('..') || back.startsWith('/')) return null;
  return abs;
}

async function authorize(slug: string, version: string, rel: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return { ok: false as const, status: 400, error: 'invalid slug' };
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version)) {
    return { ok: false as const, status: 400, error: 'invalid version' };
  }
  const dir = papercuspPath('templates', slug, version);
  if (!existsSync(dir)) return { ok: false as const, status: 404, error: 'template not found' };
  const allowlist = await loadAllowlist(dir);
  if (!allowlist.includes(rel)) {
    return { ok: false as const, status: 403, error: `path "${rel}" not in template allowlist` };
  }
  const abs = resolveSafe(dir, rel);
  if (!abs) return { ok: false as const, status: 400, error: 'path resolves outside template' };
  return { ok: true as const, abs };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; version: string }> },
) {
  const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
  if (blocked) return blocked;
  const { slug, version } = await ctx.params;
  const url = new URL(req.url);
  const rel = url.searchParams.get('path') ?? '';
  if (!rel) return NextResponse.json({ error: 'path query param required' }, { status: 400 });
  const auth = await authorize(slug, version, rel);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!existsSync(auth.abs)) {
    return NextResponse.json({ path: rel, content: null, exists: false });
  }
  const content = await fs.readFile(auth.abs, 'utf8').catch(() => null);
  return NextResponse.json({ path: rel, content, exists: content !== null });
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ slug: string; version: string }> },
) {
  const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
  if (blocked) return blocked;
  const { slug, version } = await ctx.params;
  let body: { path?: string; content?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const rel = String(body.path ?? '').trim();
  if (!rel) return NextResponse.json({ error: 'path required' }, { status: 400 });
  const auth = await authorize(slug, version, rel);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const content = typeof body.content === 'string' ? body.content : null;
  if (content === null) return NextResponse.json({ error: 'content (string) required' }, { status: 400 });
  await fs.mkdir(dirname(auth.abs), { recursive: true });
  await fs.writeFile(auth.abs, content, 'utf8');
  return NextResponse.json({ ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') });
}
