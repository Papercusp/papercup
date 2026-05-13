/**
 * POST /api/templates/<slug>/<version>/install
 *
 * Materialises a saved template directly into a new harness, bypassing
 * the marketplace round-trip. Useful for testing a template before
 * publishing.
 *
 * Body:
 *   { projectSlug: string, targetPath?: string }
 *
 * Steps:
 *   1. Resolve target dir (body.targetPath or ~/papercusp-projects/<slug>).
 *   2. Refuse if anything's already there or the slug is registered.
 *   3. Copy the template's source files (everything *except* the
 *      papercusp.json wrapper, which is template-only metadata) into
 *      the target.
 *   4. Register via the existing POST /api/harness/projects so the new
 *      harness shows up in the operator listing + gets a per-harness
 *      Postgres schema provisioned by the registry handler.
 */

import { NextResponse } from 'next/server';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

interface Body {
  projectSlug?: string;
  targetPath?: string;
}

const SKIP = new Set(['papercusp.json', '.published.json']);

async function copyDir(src: string, dst: string): Promise<string[]> {
  const copied: string[] = [];
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dst, { recursive: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      const inner = await copyDir(s, d);
      for (const p of inner) copied.push(join(e.name, p));
    } else {
      await fs.copyFile(s, d);
      copied.push(e.name);
    }
  }
  return copied;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; version: string }> },
) {
  const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
  if (blocked) return blocked;
  const { slug, version } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Body;

  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ ok: false, error: 'invalid slug' }, { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version)) {
    return NextResponse.json({ ok: false, error: 'invalid version' }, { status: 400 });
  }

  const projectSlug = (body.projectSlug ?? `${slug}-test`).trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(projectSlug)) {
    return NextResponse.json(
      { ok: false, error: `invalid projectSlug "${projectSlug}" (lowercase letters, digits, hyphens)` },
      { status: 400 },
    );
  }

  const templateDir = papercuspPath('templates', slug, version);
  if (!existsSync(templateDir)) {
    return NextResponse.json({ ok: false, error: 'template not found' }, { status: 404 });
  }

  const targetPath = body.targetPath
    ? resolve(body.targetPath.trim())
    : join(homedir(), 'papercusp-projects', projectSlug);

  if (existsSync(targetPath)) {
    return NextResponse.json(
      { ok: false, error: `targetPath already exists at ${targetPath}` },
      { status: 409 },
    );
  }

  const copied = await copyDir(templateDir, targetPath);

  // Hand off to the existing project-registration endpoint so the new
  // harness gets the standard treatment (PG schema provisioning, registry
  // entry, parent-slug discovery). Hitting it via fetch keeps us out of
  // the import graph for the Hono app.
  const origin = new URL(req.url).origin;
  const reg = await fetch(`${origin}/api/harness/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: req.headers.get('cookie') ?? '' },
    body: JSON.stringify({ slug: projectSlug, path: targetPath }),
  });
  const regJson = await reg.json().catch(() => ({}));
  if (!reg.ok) {
    // Rollback the copy so a failed registration doesn't leave orphan files.
    try { await fs.rm(targetPath, { recursive: true, force: true }); } catch { /* leak on failure */ }
    return NextResponse.json(
      { ok: false, error: `registry rejected the new project: ${regJson.error ?? reg.status}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    projectSlug,
    targetPath,
    templateSlug: slug,
    templateVersion: version,
    copiedCount: copied.length,
    operatorUrl: `/harness/${encodeURIComponent(projectSlug)}`,
  });
}
