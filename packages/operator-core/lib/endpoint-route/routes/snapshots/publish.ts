/**
 * POST /api/snapshots/:id/publish — publish a snapshot to the Cupboard
 * (revive-cupboard-distribution-2026-06-04 P1 / D-002). REPLACES the dead
 * `:3057` marketplace tarball-upload (D-004).
 *
 * The Cupboard listing row is GitHub-repo-backed + metadata-only: a
 * `kind=snapshot` listing points at the snapshot's source-harness repo +
 * `listing_ref` = the snapshot id. The TARBALL travels through the Cupboard's R2
 * blob store (worker migration 005, binding SNAPSHOTS), content-addressed at
 * `snapshots/<sha256>.tar.gz` — owner decision 2026-06-04: snapshots are
 * cross-machine forkable NOW, not deferred to the project remote. So publish
 * uploads the tarball, then registers a listing carrying tarball_r2_key/
 * _content_hash/_bytes; another machine forks it via /snapshots/fork-from-cupboard
 * (download → verify → restore). Local fork still works via /snapshots/:id/instantiate.
 *
 * `auth: 'public'` — flag-gated (FLAGS.SNAPSHOTS).
 */
import { promises as fs } from 'node:fs';
import { findSnapshot } from '../../../snapshot-discovery';
import { reconcileTarballIntoIndex } from '../../../snapshot-index';
import { withSnapshotLock } from '../../../snapshot-locks';
import { recordUserAction } from '../../../user-actions';
import { resolveHarnessPaths } from '../../../resolve-harness-paths';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  resolveRepoCoordsFromDir,
  gitOriginUrl,
  fetchGithubRepoMeta,
} from '../../../cupboard/resolve-repo-coords';
import { publishListingToCupboard } from '../../../cupboard/publish-listing';
import { uploadSnapshotTarball } from '../../../cupboard/snapshot-blob';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  project_ref?: string;
  title?: string;
  description?: string;
}

export default defineTool({
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
          const json = (await cloned.json().catch(() => ({}))) as { ok?: boolean; browseUrl?: string };
          return {
            summary: json.ok ? `Published snapshot ${id} to the Cupboard` : `Publish rejected for ${id}`,
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

  // Resolve the source-harness repo coords (the Cupboard listing is repo-backed).
  const { projectDir } = await resolveHarnessPaths(snap.harnessSlug, activeWorkspaceId());
  const coords = await resolveRepoCoordsFromDir(projectDir, {
    getOriginUrl: gitOriginUrl,
    fetchRepoMeta: fetchGithubRepoMeta,
  });
  if ('error' in coords) {
    // No GitHub-backed harness → can't list it. The snapshot still forks locally
    // (POST /snapshots/:id/instantiate) — publishing to the storefront is what
    // needs a repo. Surface the reason rather than silently failing.
    return Response.json(
      {
        ok: false,
        error: `cannot publish snapshot to the Cupboard: ${coords.error}`,
        hint: 'snapshots fork locally via /snapshots/:id/instantiate without publishing; publishing to the storefront needs a GitHub-backed source harness',
      },
      { status: 422 },
    );
  }

  // Upload the tarball to the Cupboard R2 blob store so the snapshot is
  // cross-machine forkable (owner decision 2026-06-04). Content-addressed +
  // idempotent. A snapshot listing without its blob can't be forked elsewhere,
  // so a failed upload fails the publish rather than minting a dangling listing.
  const upload = await uploadSnapshotTarball(snap.tarballPath);
  if (!upload.ok) {
    return Response.json(
      { ok: false, error: upload.error, detail: upload.detail },
      { status: upload.status === 401 ? 401 : 502 },
    );
  }

  const result = await publishListingToCupboard({
    listing_kind: 'snapshot',
    listing_ref: id,
    project_ref: typeof body.project_ref === 'string' ? body.project_ref : undefined,
    ...coords,
    title: typeof body.title === 'string' ? body.title : (snap.manifest.name ?? id),
    description:
      typeof body.description === 'string'
        ? body.description
        : (snap.manifest.description ?? undefined),
    tarball_r2_key: upload.key,
    tarball_content_hash: upload.sha256,
    tarball_bytes: upload.bytes,
  });
  if (!result.ok) {
    return Response.json(
      { ok: false, error: result.error, detail: result.detail, upstream_status: result.upstream_status },
      { status: result.status },
    );
  }

  const listing = (result.data as { id?: string; listing?: { id?: string } }) ?? {};
  const listingId = listing.id ?? listing.listing?.id ?? id;
  const browseUrl = `papercusp://cupboard/${encodeURIComponent(String(listingId))}`;

  // Record the publish locally so PG-backed discovery's `published` stays in sync
  // (the snapshot tarball + index row remain the local source of truth). KEEP the
  // reconcile after the sidecar write (su-5e01e0f0 / E3-P006): it mirrors the
  // publish into snapshot_index.published.
  await recordPublish(snap.tarballPath, {
    slug: id,
    version: String(listingId),
    browseUrl,
    publishedAtMs: Date.now(),
  });
  await reconcileTarballIntoIndex(snap.tarballPath).catch(() => {});

  return Response.json({ ok: true, listing: result.data, id: listingId, browseUrl });
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
