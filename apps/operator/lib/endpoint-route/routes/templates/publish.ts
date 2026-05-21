/**
 * POST /api/templates/:slug/:version/publish
 *
 * Tars up ~/.papercusp/templates/<slug>/<version>/ and uploads it to the
 * marketplace at :3057. Mirrors the snapshot publish flow but the
 * source is a recipe-only template directory rather than a pre-built
 * tarball.
 *
 * Ported from app/api/templates/[slug]/[version]/publish/route.ts.
 * `auth: 'public'`, `timeoutSec: 600`.
 */
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { papercuspPath } from '@/lib/papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { readFirstServiceToken } from '@/lib/marketplace-token';
import { defineTool } from '@papercusp/agent-mcp';

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
const MARKETPLACE_SITE_URL = process.env.PAPERCUSP_MARKETPLACE_SITE_URL ?? 'http://localhost:3060';

interface Body {
  marketplaceSlug?: string;
  marketplaceVersion?: string;
}

interface PublishRecord {
  slug: string;
  version: string;
  browseUrl: string;
  publishedAtMs: number;
}

async function tarDir(dir: string, filename: string): Promise<{ tarballPath: string; cleanup: () => Promise<void> }> {
  const tmpRoot = await fs.mkdtemp(join(homedir(), '.papercusp-publish-'));
  const out = join(tmpRoot, filename);
  await new Promise<void>((res, rej) => {
    const child = spawn('tar', ['-czf', out, '-C', dir, '.']);
    child.on('error', rej);
    child.on('close', (code) => code === 0 ? res() : rej(new Error(`tar exited with code ${code}`)));
  });
  return {
    tarballPath: out,
    cleanup: async () => {
      try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* leak */ }
    },
  };
}

async function recordPublish(dir: string, rec: PublishRecord): Promise<void> {
  const sidecar = join(dir, '.published.json');
  let existing: PublishRecord[] = [];
  try {
    const raw = await fs.readFile(sidecar, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed.filter((x) => x && typeof x === 'object');
  } catch { /* fresh file */ }
  const next = existing.filter((e) => !(e.slug === rec.slug && e.version === rec.version));
  next.push(rec);
  await fs.writeFile(sidecar, JSON.stringify(next, null, 2), 'utf8');
}

export default defineTool({
  method: 'POST',
  path: '/templates/:slug/:version/publish',
  auth: 'public',
  timeoutSec: 600,
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
    if (blocked) return blocked;
    const { slug, version } = ctx.params;
    const body = (await req.json().catch(() => ({}))) as Body;

    const dir = papercuspPath('templates', slug, version);
    if (!existsSync(dir)) {
      return Response.json({ ok: false, error: 'template not found' }, { status: 404 });
    }
    const manifestPath = join(dir, 'papercusp.json');
    if (!existsSync(manifestPath)) {
      return Response.json({ ok: false, error: 'template missing papercusp.json' }, { status: 400 });
    }

    const token = await readFirstServiceToken();
    if (!token) {
      return Response.json(
        {
          ok: false,
          error: 'no marketplace service token in ~/.papercusp/marketplace-secrets.env',
        },
        { status: 412 },
      );
    }

    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (e) {
      return Response.json(
        { ok: false, error: `papercusp.json invalid JSON: ${(e as Error).message}` },
        { status: 400 },
      );
    }

    const publishSlug = body.marketplaceSlug ?? slug;
    const publishVersion = body.marketplaceVersion ?? String(manifest.version ?? version);

    const marketplaceManifest = {
      ...manifest,
      name: publishSlug,
      version: publishVersion,
      kind: manifest.kind ?? 'template',
    };

    const { tarballPath, cleanup } = await tarDir(
      dir,
      `${publishSlug.replace(/\//g, '__')}-${publishVersion}.tar.gz`,
    );

    try {
      const tarballBytes = await fs.readFile(tarballPath);

      const readmePath = join(dir, 'README.md');
      let readmeBlob: Blob | null = null;
      if (existsSync(readmePath)) {
        const readmeBytes = await fs.readFile(readmePath);
        readmeBlob = new Blob([new Uint8Array(readmeBytes)], { type: 'text/markdown' });
      }

      const form = new FormData();
      form.append('manifest', JSON.stringify(marketplaceManifest));
      form.append(
        'tarball',
        new Blob([new Uint8Array(tarballBytes)], { type: 'application/gzip' }),
        `${publishSlug.replace(/\//g, '__')}-${publishVersion}.tar.gz`,
      );
      if (readmeBlob) form.append('readme', readmeBlob, 'README.md');

      const url = `${MARKETPLACE_URL}/publish/${encodeURIComponent(publishSlug)}/${encodeURIComponent(publishVersion)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });

      const respBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        return Response.json(
          { ok: false, error: `marketplace rejected (${res.status})`, detail: respBody },
          { status: 502 },
        );
      }

      const browseUrl = `${MARKETPLACE_SITE_URL}/marketplace/${publishSlug}/${publishVersion}`;
      await recordPublish(dir, {
        slug: publishSlug,
        version: publishVersion,
        browseUrl,
        publishedAtMs: Date.now(),
      });

      return Response.json({ ok: true, slug: publishSlug, version: publishVersion, browseUrl });
    } finally {
      await cleanup();
    }
  },
});
