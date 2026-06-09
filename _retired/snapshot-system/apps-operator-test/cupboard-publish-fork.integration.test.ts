/**
 * THE publish→fork content-addressing round-trip for cross-machine snapshot
 * distribution (revive-cupboard-distribution-2026-06-04, snapshot facet; owner
 * decision 2026-06-04: snapshots fork cross-machine NOW via the Cupboard's R2
 * blob store). This is the most important seam in the cupboard domain and the
 * one the leaf tests never join: machine A's PUBLISH uploads a tarball + mints a
 * listing carrying its sha256; machine B's FORK reads that listing, downloads the
 * blob, and re-verifies the sha — and the two shas MUST be the same value. The
 * key IS the content hash end-to-end; that contract is what makes a tampered or
 * mismatched blob un-forkable.
 *
 * The Cupboard worker is modelled by msw as a CONTENT-ADDRESSED blob+listing
 * store (PUT/GET /blobs/snapshots/:sha keyed by sha; POST/GET /listings). The
 * REAL transport functions run against it — uploadSnapshotTarball,
 * publishListingToCupboard (publish side) and fetchCupboardListing,
 * downloadSnapshotTarball driven through the REAL fork-from-cupboard route
 * handler (fork side). Only `restore` (the local harness write) is stubbed —
 * we assert the verified tarball it receives, not its filesystem effects.
 *
 * Covers, after the happy round-trip:
 *   - non-snapshot listing → 400 (wrong kind, pre-restore guard)
 *   - metadata-only listing (no tarball_content_hash) → 422 (can't cross-machine fork)
 *   - listing-not-found → 404
 *   - a worker that serves a TAMPERED blob → 422 sha_mismatch (download rejects it
 *     before restore — the integrity teeth of content-addressing)
 *
 * gh-token, attestation, the flag gate, and recordUserAction are mocked (no `gh`
 * subprocess, no PostHog, no PG); the transport + route logic run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupMsw, msw } from '@papercusp/test-config';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const CUPBOARD = 'https://cupboard.test';
process.env.PAPERCUSP_CUPBOARD_URL = CUPBOARD;

// ── Mocks for the non-transport seams ────────────────────────────────────────
vi.mock('@papercusp/operator-core/lib/identity/gh-token', () => ({
  getGhAuthToken: vi.fn(async () => ({ kind: 'ok', token: 'gh-int-test' })),
}));
vi.mock('@papercusp/operator-core/lib/endpoint-route/routes/harness/cupboard-publish', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveCupboardBaseUrl: () => CUPBOARD,
  resolvePublisherAttestation: vi.fn(async () => null),
}));
// Flag gate: always allow (FLAGS.SNAPSHOTS is on for V1-snapshots anyway, but
// don't hit PostHog).
vi.mock('@papercusp/operator-core/lib/require-flag', () => ({ gateApiRoute: async () => null }));
// recordUserAction normally writes a PG audit row; here it just runs the work
// and returns its result (mirroring the real `return out.result`).
vi.mock('@papercusp/operator-core/lib/user-actions', () => ({
  recordUserAction: vi.fn(async (_slug: string, _kind: string, fn: (id: number) => Promise<{ result: unknown }>) => {
    return (await fn(0)).result;
  }),
}));
// restore() is the local harness write — stub it and capture the tarball it's
// handed so we can read back the sha the fork verified by.
const restoreCalls: Array<{ snapshotPath: string }> = [];
vi.mock('@papercusp/export-state', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restore: vi.fn(async (args: { snapshotPath: string }) => {
    restoreCalls.push({ snapshotPath: args.snapshotPath });
    return { newSlug: 'forked-demo', warnings: [], ambiguousSlugMatches: [] };
  }),
}));

// Imported AFTER the mocks (vi.mock is hoisted).
import { uploadSnapshotTarball } from '@papercusp/operator-core/lib/cupboard/snapshot-blob';
import { publishListingToCupboard } from '@papercusp/operator-core/lib/cupboard/publish-listing';
import { restore } from '@papercusp/export-state';
import forkRoute from '@papercusp/operator-core/lib/endpoint-route/routes/snapshots/fork-from-cupboard';

type Route = { handler: (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response> };
function forkPost(body: unknown): Promise<Response> {
  return (forkRoute as unknown as Route).handler(
    new Request(`http://localhost:3070/api/snapshots/fork-from-cupboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: {} },
  );
}

// ── The Cupboard worker as a content-addressed store ─────────────────────────
interface StoredListing {
  id: string;
  listing_kind: string;
  listing_ref?: string;
  tarball_content_hash?: string | null;
  tarball_r2_key?: string | null;
  tarball_bytes?: number | null;
  title?: string;
}
let blobs: Map<string, Uint8Array>;
let listings: Map<string, StoredListing>;
let listingSeq: number;
/** Set to true to have the blob GET serve TAMPERED bytes (sha-mismatch test). */
let serveTamperedBlob = false;

function workerHandlers() {
  return [
    // PUT /blobs/snapshots/:sha — content-addressed; the worker re-verifies that
    // the body hashes to the key (the key IS the sha) before storing.
    http.put(`${CUPBOARD}/blobs/snapshots/:sha`, async ({ params, request }) => {
      const sha = String(params.sha);
      const body = new Uint8Array(await request.arrayBuffer());
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== sha) {
        return HttpResponse.json({ error: 'content_hash_mismatch' }, { status: 422 });
      }
      const deduped = blobs.has(sha);
      blobs.set(sha, body);
      return HttpResponse.json({ ok: true, bytes: body.byteLength, deduped });
    }),
    // GET /blobs/snapshots/:sha — serve the stored bytes (or tampered, if armed).
    http.get(`${CUPBOARD}/blobs/snapshots/:sha`, ({ params }) => {
      const sha = String(params.sha);
      const stored = blobs.get(sha);
      if (!stored) return new HttpResponse('', { status: 404 });
      const out = serveTamperedBlob ? new TextEncoder().encode('tampered-on-the-wire') : stored;
      return new HttpResponse(out, { status: 200, headers: { 'content-type': 'application/gzip' } });
    }),
    // POST /listings — mint a metadata-only listing row carrying the blob coords.
    http.post(`${CUPBOARD}/listings`, async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      const id = `listing-${++listingSeq}`;
      const row: StoredListing = {
        id,
        listing_kind: String(b.listing_kind),
        listing_ref: b.listing_ref as string | undefined,
        tarball_content_hash: (b.tarball_content_hash as string | undefined) ?? null,
        tarball_r2_key: (b.tarball_r2_key as string | undefined) ?? null,
        tarball_bytes: (b.tarball_bytes as number | undefined) ?? null,
        title: b.title as string | undefined,
      };
      listings.set(id, row);
      return HttpResponse.json({ ok: true, id });
    }),
    // GET /listings/:id — public listing read.
    http.get(`${CUPBOARD}/listings/:id`, ({ params }) => {
      const row = listings.get(String(params.id));
      if (!row) return new HttpResponse('', { status: 404 });
      return HttpResponse.json(row);
    }),
  ];
}

setupMsw();

beforeEach(() => {
  blobs = new Map();
  listings = new Map();
  listingSeq = 0;
  serveTamperedBlob = false;
  restoreCalls.length = 0;
  vi.clearAllMocks();
  (restore as Mock).mockImplementation(async (args: { snapshotPath: string }) => {
    restoreCalls.push({ snapshotPath: args.snapshotPath });
    return { newSlug: 'forked-demo', warnings: [], ambiguousSlugMatches: [] };
  });
  msw.use(...workerHandlers());
});

let tmpTarball: string;
afterEach(async () => {
  if (tmpTarball) await fs.rm(tmpTarball, { force: true }).catch(() => {});
});

/** Publish a fresh tarball through the REAL transport; returns the listing id + sha. */
async function publishSnapshot(): Promise<{ listingId: string; sha256: string; bytes: number }> {
  const payload = randomBytes(512); // stands in for the .tar.gz bytes
  const sha256 = createHash('sha256').update(payload).digest('hex');
  tmpTarball = join(tmpdir(), `cupboard-rt-${sha256.slice(0, 12)}.tar.gz`);
  await fs.writeFile(tmpTarball, payload);

  const upload = await uploadSnapshotTarball(tmpTarball);
  expect(upload.ok).toBe(true);
  if (!upload.ok) throw new Error('upload failed');
  // Content-addressing on the publish side: the upload key IS the sha.
  expect(upload.sha256).toBe(sha256);
  expect(upload.key).toBe(`snapshots/${sha256}.tar.gz`);

  const res = await publishListingToCupboard({
    listing_kind: 'snapshot',
    listing_ref: 'snap_rt',
    github_repository_id: 1,
    github_owner: 'acme',
    github_name: 'widget',
    github_url: 'https://github.com/acme/widget',
    title: 'Round-trip snapshot',
    tarball_r2_key: upload.key,
    tarball_content_hash: upload.sha256,
    tarball_bytes: upload.bytes,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('publish failed');
  const listingId = (res.data as { id: string }).id;
  return { listingId, sha256: upload.sha256, bytes: upload.bytes };
}

describe('cupboard publish→fork content-addressing round-trip', () => {
  it('the sha uploaded at publish == the tarball_content_hash the fork verifies by', async () => {
    const { listingId, sha256 } = await publishSnapshot();

    // The minted listing carries exactly the publish sha as its content hash.
    expect(listings.get(listingId)!.tarball_content_hash).toBe(sha256);

    // Machine B forks it through the REAL route → fetch listing → download blob →
    // verify sha → restore.
    const res = await forkPost({ listing_id: listingId });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; newSlug: string };
    expect(json.ok).toBe(true);
    expect(json.newSlug).toBe('forked-demo');

    // restore got the verified tarball — its temp path is named by the SAME sha
    // the publish produced (the end-to-end content-addressing contract).
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0].snapshotPath).toContain(sha256);

    // And the bytes restore saw hash back to that sha (re-verify the contract).
    const restoredBytes = await fs.readFile(restoreCalls[0].snapshotPath).catch(() => null);
    // The fork route deletes the temp file in `finally`, so reading it post-hoc
    // may miss it — assert via the path name (above) which encodes the hash.
    if (restoredBytes) {
      expect(createHash('sha256').update(restoredBytes).digest('hex')).toBe(sha256);
    }
  });

  it('publish is idempotent: re-uploading identical bytes dedupes blob-side', async () => {
    const payload = randomBytes(256);
    const sha = createHash('sha256').update(payload).digest('hex');
    tmpTarball = join(tmpdir(), `cupboard-dedup-${sha.slice(0, 12)}.tar.gz`);
    await fs.writeFile(tmpTarball, payload);

    const first = await uploadSnapshotTarball(tmpTarball);
    const second = await uploadSnapshotTarball(tmpTarball);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true); // worker saw the key already
    expect(first.sha256).toBe(second.sha256);
    expect(blobs.size).toBe(1);
  });
});

describe('fork pre-restore guards', () => {
  it('404 when the listing is not found', async () => {
    const res = await forkPost({ listing_id: 'no-such-listing' });
    expect(res.status).toBe(404);
    expect(restore).not.toHaveBeenCalled();
  });

  it('400 for a non-snapshot listing (wrong kind)', async () => {
    listings.set('lp-1', { id: 'lp-1', listing_kind: 'plugin', listing_ref: 'a-plugin' });
    const res = await forkPost({ listing_id: 'lp-1' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('plugin');
    expect(restore).not.toHaveBeenCalled();
  });

  it('422 for a metadata-only snapshot listing (no tarball_content_hash)', async () => {
    listings.set('ls-meta', { id: 'ls-meta', listing_kind: 'snapshot', listing_ref: 'snap_meta', tarball_content_hash: null });
    const res = await forkPost({ listing_id: 'ls-meta' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('metadata-only');
    expect(restore).not.toHaveBeenCalled();
  });

  it('400 when listing_id is missing', async () => {
    const res = await forkPost({});
    expect(res.status).toBe(400);
    expect(restore).not.toHaveBeenCalled();
  });

  it('422 sha_mismatch when the worker serves a TAMPERED blob — rejected before restore', async () => {
    const { listingId } = await publishSnapshot();
    serveTamperedBlob = true; // worker now returns bytes that don't hash to the key

    const res = await forkPost({ listing_id: listingId });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('sha_mismatch');
    // The integrity teeth: a tampered blob never reaches restore.
    expect(restore).not.toHaveBeenCalled();
  });
});
