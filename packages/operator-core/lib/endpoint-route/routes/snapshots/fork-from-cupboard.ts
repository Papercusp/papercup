/**
 * POST /api/snapshots/fork-from-cupboard — fork a snapshot published on ANOTHER
 * machine, by fetching its tarball from the Cupboard R2 blob store
 * (revive-cupboard-distribution-2026-06-04, snapshot facet; owner decision
 * 2026-06-04: snapshots are cross-machine forkable now).
 *
 * The complement to /snapshots/:id/instantiate (which forks a LOCAL snapshot):
 *   1. fetch the Cupboard listing (GET /listings/:id) → its tarball_content_hash;
 *   2. download the tarball from GET /blobs/snapshots/<hash> + VERIFY the sha256;
 *   3. restore() it into a new local harness, exactly like local instantiate.
 *
 * The transport tarball is staged in a temp file and removed after restore — the
 * fork produces a harness, not a retained local snapshot (re-fork from the
 * Cupboard if needed). A metadata-only listing (no tarball_content_hash, e.g. one
 * published before migration 005) can't be cross-machine forked — surfaced, not
 * silently failed.
 *
 * `auth: 'public'` — flag-gated (FLAGS.SNAPSHOTS).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restore } from '@papercusp/export-state';
import { withSnapshotLock } from '../../../snapshot-locks';
import { recordUserAction } from '../../../user-actions';
import { papercuspPath } from '../../../papercusp-root';
import { downloadSnapshotTarball, fetchCupboardListing } from '../../../cupboard/snapshot-blob';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { defineTool } from '@papercusp/agent-mcp';

function PROJECTS_DIR() { return papercuspPath('projects'); }

interface Body {
  /** The Cupboard listing id (uuid) of the snapshot to fork. */
  listing_id?: string;
  acceptPartial?: boolean;
  rewriteAmbiguousSlugs?: boolean;
}

export default defineTool({
  method: 'POST',
  path: '/snapshots/fork-from-cupboard',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const body = (await req.json().catch(() => ({}))) as Body;
    const listingId = typeof body.listing_id === 'string' ? body.listing_id.trim() : '';
    if (!listingId) {
      return Response.json({ ok: false, error: 'listing_id required' }, { status: 400 });
    }

    const listing = await fetchCupboardListing(listingId);
    if (!listing) {
      return Response.json({ ok: false, error: 'cupboard listing not found' }, { status: 404 });
    }
    if (listing.listing_kind !== 'snapshot') {
      return Response.json(
        { ok: false, error: `listing ${listingId} is a ${listing.listing_kind ?? 'non-snapshot'} listing, not a snapshot` },
        { status: 400 },
      );
    }
    const hash = listing.tarball_content_hash;
    if (!hash) {
      return Response.json(
        {
          ok: false,
          error: 'this snapshot listing has no published tarball (metadata-only), so it cannot be forked cross-machine',
          hint: 'it can only be forked on the machine that captured it, via /snapshots/:id/instantiate',
        },
        { status: 422 },
      );
    }

    const snapshotId = listing.listing_ref ?? listingId;
    return withSnapshotLock(snapshotId, async () =>
      recordUserAction('_cupboard', 'snapshot.fork-from-cupboard', async () => {
        const res = await forkFromCupboard(hash, body);
        const json = (await res.clone().json().catch(() => ({}))) as { ok?: boolean; newSlug?: string };
        return {
          summary: json.ok
            ? `Forked Cupboard snapshot ${snapshotId} → ${json.newSlug ?? '?'}`
            : `Cupboard fork rejected for ${snapshotId}`,
          result: res,
        };
      }),
    );
  },
});

async function forkFromCupboard(contentHash: string, body: Body): Promise<Response> {
  const dl = await downloadSnapshotTarball(contentHash);
  if (!dl.ok) {
    return Response.json(
      { ok: false, error: dl.error, detail: dl.detail },
      { status: dl.error === 'sha_mismatch' ? 422 : 502 },
    );
  }

  // Stage the verified tarball in a temp file — restore() reads it off disk, then
  // we drop it (the fork output is a harness, not a retained local snapshot).
  const tmpPath = join(tmpdir(), `papercusp-fork-${contentHash}.tar.gz`);
  try {
    await fs.writeFile(tmpPath, dl.bytes);
    const result = await restore({
      snapshotPath: tmpPath,
      targetProjectsDir: PROJECTS_DIR(),
      substrateVersion: '0.0.1',
      schemaVersionDb: 0,
      acceptPartial: !!body.acceptPartial,
      ambiguousMatchPolicy: body.rewriteAmbiguousSlugs ? 'rewrite-all' : 'skip-all',
      consent: 'grant-all',
    });
    return Response.json({
      ok: true,
      newSlug: result.newSlug,
      projectDir: join(PROJECTS_DIR(), result.newSlug),
      warnings: result.warnings ?? [],
      ambiguousSlugMatches: result.ambiguousSlugMatches,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}
