/**
 * POST /api/snapshots/:id/retract — unlist a snapshot from the Cupboard
 * (revive-cupboard-distribution-2026-06-04 P1 / D-004). REPLACES the dead
 * `:3057` marketplace deprecate/withdraw/yank proxy.
 *
 * The Cupboard has ONE retraction primitive — unlist (DELETE /listings/:id) —
 * not the marketplace's deprecate/withdraw/yank lifecycle. So retracting a
 * published snapshot = DELETE its listing(s). The listing ids are recorded in
 * the snapshot's local `.published.json` sidecar (written at publish time) OR
 * can be passed explicitly. Auth is the publisher's gh-token (the Cupboard
 * gates DELETE on publisher/claimant identity).
 *
 * `auth: 'public'` — flag-gated (FLAGS.SNAPSHOTS).
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { findSnapshot } from '../../../snapshot-discovery';
import { readPublishesSidecar } from '../../../snapshot-index';
import { reconcileTarballIntoIndex } from '../../../snapshot-index';
import { getGhAuthToken } from '../../../identity/gh-token';
import { resolveCupboardBaseUrl } from '../harness/cupboard-publish';
import { promises as fs } from 'node:fs';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  /** Explicit Cupboard listing id(s) to unlist; defaults to the sidecar's recorded ids. */
  listingId?: string;
  listingIds?: string[];
}

export default defineTool({
  method: 'POST',
  path: '/snapshots/:id/retract',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const id = ctx.params.id as string;

    const snap = await findSnapshot(id);
    if (!snap) {
      return Response.json({ ok: false, error: 'snapshot not found locally' }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    // Listing ids: explicit, else the sidecar's recorded publish ids (version field).
    let listingIds: string[] = [];
    if (Array.isArray(body.listingIds)) listingIds = body.listingIds.map(String).filter(Boolean);
    else if (typeof body.listingId === 'string' && body.listingId) listingIds = [body.listingId];
    else {
      const published = await readPublishesSidecar(snap.tarballPath);
      listingIds = published.map((p) => p.version).filter(Boolean);
    }
    if (listingIds.length === 0) {
      return Response.json(
        { ok: false, error: 'no Cupboard listing recorded for this snapshot — nothing to retract (pass listingId to override)' },
        { status: 400 },
      );
    }

    const tokenRes = await getGhAuthToken();
    if (tokenRes.kind !== 'ok') {
      return Response.json({ ok: false, error: 'gh_auth_required', detail: tokenRes.error.kind }, { status: 401 });
    }
    const base = resolveCupboardBaseUrl();
    const results: Array<{ listingId: string; ok: boolean; status: number; error?: string }> = [];
    for (const listingId of listingIds) {
      try {
        const res = await fetch(`${base}/listings/${encodeURIComponent(listingId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tokenRes.token}`, 'User-Agent': 'papercusp-operator-cupboard-proxy' },
          signal: AbortSignal.timeout(10_000),
        });
        results.push({ listingId, ok: res.ok, status: res.status, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) });
      } catch (e) {
        results.push({ listingId, ok: false, status: 0, error: (e as Error).message.slice(0, 200) });
      }
    }

    // Drop the unlisted ids from the local sidecar so discovery's `published` no
    // longer claims a live listing, then reconcile into the PG index.
    const unlisted = new Set(results.filter((r) => r.ok).map((r) => r.listingId));
    if (unlisted.size > 0) {
      await pruneSidecar(snap.tarballPath, unlisted).catch(() => {});
      await reconcileTarballIntoIndex(snap.tarballPath).catch(() => {});
    }

    const allOk = results.every((r) => r.ok);
    return Response.json({ ok: allOk, retracted: results }, { status: allOk ? 200 : 502 });
  },
});

/** Remove publish records whose listing id (version) was unlisted. */
async function pruneSidecar(tarballPath: string, unlistedIds: Set<string>): Promise<void> {
  const sidecar = tarballPath.replace(/\.tar\.gz$/, '.published.json');
  let existing: Array<{ slug: string; version: string; browseUrl: string; publishedAtMs: number }> = [];
  try {
    const parsed = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    if (Array.isArray(parsed)) existing = parsed.filter((x) => x && typeof x === 'object');
  } catch { return; }
  const next = existing.filter((e) => !unlistedIds.has(e.version));
  await fs.writeFile(sidecar, JSON.stringify(next, null, 2), 'utf8');
}
