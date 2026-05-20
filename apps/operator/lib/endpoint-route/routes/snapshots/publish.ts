/**
 * POST /api/snapshots/:id/publish
 *
 * Uploads a local snapshot to the papercusp marketplace via multipart.
 * Auth via the service token in ~/.papercusp/marketplace-secrets.env.
 *
 * Ported from app/api/snapshots/[id]/publish/route.ts. `auth: 'public'` — flag-gated.
 */
import { promises as fs } from 'node:fs';
import { findSnapshot } from '@/lib/snapshot-discovery';
import { withSnapshotLock } from '@/lib/snapshot-locks';
import { recordUserAction } from '@/lib/user-actions';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { readFirstServiceToken } from '@/lib/marketplace-token';
import { defineRoute } from '../../define-route';

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';

interface Body {
  marketplaceSlug?: string;
  marketplaceVersion?: string;
}

export default defineRoute({
  method: 'POST',
  path: '/snapshots/:id/publish',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const id = ctx.params.id as string;
    const body = (await req.json().catch(() => ({}))) as Body;
    return withSnapshotLock(id, async () => {
      const snap = await findSnapshot(id);
      const slug = snap?.harnessSlug ?? '_unknown';
      try {
        return await recordUserAction(slug, 'snapshot.publish', async () => {
          const res = await publish(id, body);
          const cloned = res.clone();
          const json = await cloned.json().catch(() => ({})) as { ok?: boolean; slug?: string; version?: string; browseUrl?: string };
          return {
            summary: json.ok
              ? `Published ${json.slug ?? id}@${json.version ?? '?'}`
              : `Publish rejected for ${id}`,
            detailUrl: json.browseUrl,
            result: res,
          };
        });
      } catch {
        return Response.json({ ok: false, error: 'publish failed' }, { status: 500 });
      }
    });
  },
});

async function publish(id: string, body: Body): Promise<Response> {
  const snap = await findSnapshot(id);
  if (!snap) return Response.json({ ok: false, error: 'snapshot not found' }, { status: 404 });

  const token = await readFirstServiceToken();
  if (!token) {
    return Response.json(
      {
        ok: false,
        error:
          'no marketplace service token in ~/.papercusp/marketplace-secrets.env (PAPERCUSP_MARKETPLACE_SERVICE_TOKENS)',
      },
      { status: 412 },
    );
  }

  const slug = body.marketplaceSlug ?? defaultSlug(snap.harnessSlug);
  const version = body.marketplaceVersion ?? `1.0.0-ts${Date.now()}`;

  const sourceIcon = await resolveSourceIcon(snap.manifest.template?.name);
  const manifestPayload = buildMarketplaceManifest(snap.manifest, slug, version, sourceIcon);

  const tarballBytes = await fs.readFile(snap.tarballPath);
  const readmePath = snap.tarballPath.replace(/\.tar\.gz$/, '.README.md');
  let readmeBlob: Blob | null = null;
  try {
    const readmeBytes = await fs.readFile(readmePath);
    readmeBlob = new Blob([new Uint8Array(readmeBytes)], { type: 'text/markdown' });
  } catch { /* optional */ }

  const form = new FormData();
  form.append('manifest', JSON.stringify(manifestPayload));
  form.append('tarball', new Blob([new Uint8Array(tarballBytes)], { type: 'application/gzip' }), `${slug}-${version}.tar.gz`);
  if (readmeBlob) form.append('readme', readmeBlob, 'README.md');

  const url = `${MARKETPLACE_URL}/publish/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (e: unknown) {
    return Response.json(
      { ok: false, error: `marketplace unreachable at ${MARKETPLACE_URL}: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const respBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    return Response.json(
      { ok: false, error: `marketplace rejected (${res.status})`, detail: respBody },
      { status: 502 },
    );
  }

  const marketplaceSite =
    process.env.PAPERCUSP_MARKETPLACE_SITE_URL ?? 'http://localhost:3060';
  const browseUrl = `${marketplaceSite}/marketplace/${slug}/${version}`;

  await recordPublish(snap.tarballPath, { slug, version, browseUrl, publishedAtMs: Date.now() });

  return Response.json({
    ok: true,
    slug,
    version,
    response: respBody,
    browseUrl,
  });
}

interface PublishRecord {
  slug: string;
  version: string;
  browseUrl: string;
  publishedAtMs: number;
}

async function recordPublish(tarballPath: string, rec: PublishRecord): Promise<void> {
  const sidecar = tarballPath.replace(/\.tar\.gz$/, '.published.json');
  let existing: PublishRecord[] = [];
  try {
    const raw = await fs.readFile(sidecar, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed.filter((x) => x && typeof x === 'object');
  } catch { /* file missing or malformed */ }
  const next = existing.filter((e) => !(e.slug === rec.slug && e.version === rec.version));
  next.push(rec);
  await fs.writeFile(sidecar, JSON.stringify(next, null, 2), 'utf8');
}

function defaultSlug(harness: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${harness}-snapshot-${date}`;
}

async function resolveSourceIcon(templateName: string | undefined): Promise<string | null> {
  if (!templateName) return null;
  const upstream = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  try {
    const r = await fetch(`${upstream}/catalog/${encodeURIComponent(templateName)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    const d = await r.json() as { latest?: { icon?: string | null } };
    return typeof d.latest?.icon === 'string' ? d.latest.icon : null;
  } catch {
    return null;
  }
}

function buildMarketplaceManifest(
  m: import('@papercusp/export-state').SnapshotManifest,
  slug: string,
  version: string,
  sourceIcon: string | null,
): Record<string, unknown> {
  return {
    name: slug,
    version,
    kind: 'snapshot',
    papercusp: '^0.1.0',
    description: m.description ?? m.name,
    license: m.license,
    icon: sourceIcon ?? 'Layers',
    author: 'papercusp-operator',
    snapshot: {
      sourceHarness: m.harnessSlug,
      template: m.template,
      filesCount: m.files.length,
      excludedCount: m.excluded.length,
      pluginsCount: m.plugins.length,
      partial: m.partial,
      capturedAt: new Date(m.createdAt).toISOString(),
      redactions: m.redactions,
      original: m,
    },
  };
}
