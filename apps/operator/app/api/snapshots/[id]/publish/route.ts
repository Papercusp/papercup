/**
 * POST /api/snapshots/<id>/publish
 *
 * Uploads a local snapshot tarball to the papercusp marketplace at
 * `:3057` (read by the public site at `:3060`). Authenticates via the
 * service token in `~/.papercusp/marketplace-secrets.env`.
 *
 *   Multipart fields per marketplace-api/server.ts:1188 :
 *     manifest  — JSON string of the snapshot's papercusp.json-shaped payload
 *     tarball   — File (the .tar.gz)
 *     readme    — optional File
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findSnapshot } from '@/lib/snapshot-discovery';
import { withSnapshotLock } from '@/lib/snapshot-locks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
const SECRETS_PATH = join(homedir(), '.papercusp', 'marketplace-secrets.env');

interface Body {
  /** Override marketplace slug. Defaults to `<harness>-snapshot-<yyyymmdd>-iter1`. */
  marketplaceSlug?: string;
  /** Override marketplace version. Defaults to `1.0.0-ts<epochms>`. */
  marketplaceVersion?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;
  return withSnapshotLock(id, () => publish(id, body));
}

async function publish(id: string, body: Body): Promise<NextResponse> {
  const snap = await findSnapshot(id);
  if (!snap) return NextResponse.json({ ok: false, error: 'snapshot not found' }, { status: 404 });

  const token = await readServiceToken();
  if (!token) {
    return NextResponse.json(
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

  const manifestPayload = buildMarketplaceManifest(snap.manifest, slug, version);

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
    return NextResponse.json(
      { ok: false, error: `marketplace unreachable at ${MARKETPLACE_URL}: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const respBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: `marketplace rejected (${res.status})`, detail: respBody },
      { status: 502 },
    );
  }

  // Marketplace site lives at :3060 (preferred for browsing).
  const marketplaceSite =
    process.env.PAPERCUSP_MARKETPLACE_SITE_URL ?? 'http://localhost:3060';
  const browseUrl = `${marketplaceSite}/marketplace/${slug}/${version}`;

  // Persist the publish record next to the tarball so the operator UI
  // (and the retract endpoint) can recall what slug+version this snapshot
  // was published as. Append-only — multiple publishes accumulate, so
  // a snapshot republished under a new version doesn't lose history.
  await recordPublish(snap.tarballPath, { slug, version, browseUrl, publishedAtMs: Date.now() });

  return NextResponse.json({
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
  } catch { /* file missing or malformed — start fresh */ }
  // Dedup on slug+version (idempotent re-publish under same coords).
  const next = existing.filter((e) => !(e.slug === rec.slug && e.version === rec.version));
  next.push(rec);
  await fs.writeFile(sidecar, JSON.stringify(next, null, 2), 'utf8');
}

function defaultSlug(harness: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${harness}-snapshot-${date}`;
}

function buildMarketplaceManifest(
  m: import('@papercusp/export-state').SnapshotManifest,
  slug: string,
  version: string,
): Record<string, unknown> {
  return {
    name: slug,
    version,
    kind: 'snapshot',
    papercusp: '^0.1.0',
    description: m.description ?? m.name,
    license: m.license,
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
      // Pass through the original manifest verbatim so consumers can
      // inspect the full shape without a separate fetch.
      original: m,
    },
  };
}

async function readServiceToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(SECRETS_PATH, 'utf8');
    // Format example:
    //   PAPERCUSP_MARKETPLACE_SERVICE_TOKENS='[{"token":"...","login":"papercupai"}]'
    for (const line of raw.split('\n')) {
      const m = /^PAPERCUSP_MARKETPLACE_SERVICE_TOKENS\s*=\s*'(.+?)'\s*$/.exec(line.trim());
      if (m) {
        const arr = JSON.parse(m[1]!) as { token: string }[];
        return arr[0]?.token ?? null;
      }
    }
  } catch { /* file missing */ }
  return null;
}
