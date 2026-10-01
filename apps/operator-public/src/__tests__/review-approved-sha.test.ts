/**
 * Review approves a SHA — cupboard-release-pipeline-content-trust-2026-09-16
 * P-008 (+ residue WI-10004625), route-level through the real
 * /admin/listings/:id/review and /review-diff handlers against REAL SQLite
 * with every shipped migration applied (the approve path is one `db.batch`
 * with an EXISTS-guarded retire statement; a hand-rolled fake cannot run it).
 *
 * D-003/D-004: the approval records the commit the OPERATOR reviewed; a row
 * that drifted is re-pinned to that SHA before it is served; and approving a
 * version makes it the single served version of its (repo, kind, ref).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { approveListingVersion } from '../db.ts';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub, type GhStubTreeEntry } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1';

type Raw = ReturnType<typeof makeSqliteDb>['raw'];
type Api = ReturnType<typeof buildApi>;
type Env = ReturnType<typeof makeEnv>['env'];
type Ctx = { api: Api; env: Env; raw: Raw };

interface Row {
  id: string;
  review_status: string;
  review_reason: string | null;
  claim_status: string;
  unlisted_at: number | null;
  unlisted_reason: string | null;
  superseded_by: string | null;
  pinned_commit_sha: string | null;
  pinned_tree_digest: string | null;
  approved_commit_sha: string | null;
  approved_tree_digest: string | null;
  approved_at: number | null;
  drift: number;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);

const PUBLISHER = { id: 5, login: 'pub' };
const OPERATOR = { id: 7, login: 'op' };
const STRANGER = { id: 9, login: 'stranger' };
const REPO_ID = 8;

const BODY = {
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: 'https://github.com/papercupai/demo-project',
  project_ref: 'papercupai/demo-project',
  github_repository_id: REPO_ID,
  listing_kind: 'plan',
  listing_ref: 'quality-plan',
};

const blob = (path: string, ch: string): GhStubTreeEntry => ({ path: `quality-plan/${path}`, sha: ch.repeat(40), size: 50 });

/** The repo's tree at each commit. A→B modifies README, removes notes, adds extra. */
const TREES: Record<string, GhStubTreeEntry[]> = {
  [A]: [blob('listing.json', '1'), blob('README.md', '2'), blob('notes.md', '5')],
  [B]: [blob('listing.json', '1'), blob('README.md', '9'), blob('extra.md', '6')],
  [C]: [blob('listing.json', '3'), blob('README.md', '2')],
  [D]: [blob('listing.json', '4'), blob('README.md', '2')],
  [E]: [blob('listing.json', '7'), blob('leaky.md', '8')],
};

/**
 * GitHub at the fetch seam. `stubGithub` serves one tree regardless of the sha
 * in the URL; the review path fetches `git/trees/<sha>` for SEVERAL shas, so
 * a wrapper answers each from TREES (everything else falls through).
 */
function stubRepo(user: { id: number; login: string }, head: string, blobs?: Record<string, { content: string }>): void {
  stubGithub({
    user,
    repo: { id: REPO_ID, private: false, permissions: { admin: true }, default_branch: 'main' },
    head: { sha: head },
    tree: { entries: TREES[head] ?? [] },
    ...(blobs ? { blobs } : {}),
  });
  const base = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const m = /\/git\/trees\/([0-9a-f]{40})/.exec(url.toString());
    if (!m) return base(url, init);
    const entries = TREES[m[1]!];
    if (!entries) return new Response('', { status: 404 });
    return new Response(
      JSON.stringify({
        sha: m[1],
        truncated: false,
        tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha, size: e.size ?? 0 })),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

function setup(): Ctx {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv({ DB: db, CUPBOARD_OPERATOR_GITHUB_IDS: String(OPERATOR.id) });
  return { api: buildApi(), env, raw };
}

const rowById = (ctx: Ctx, id: string): Row =>
  ctx.raw.prepare('SELECT * FROM harnesses WHERE id = ?').get(id) as unknown as Row;

/** Publish the plan at `sha` as the publisher; pin created_at so ordering is deterministic. */
async function publishAt(ctx: Ctx, sha: string, createdAt: number): Promise<string> {
  stubRepo(PUBLISHER, sha);
  const res = await ctx.api.request(
    '/listings',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(BODY),
    },
    ctx.env,
  );
  expect(res.status).toBe(200);
  const row = ctx.raw.prepare('SELECT id FROM harnesses WHERE pinned_commit_sha = ?').get(sha) as unknown as { id: string };
  ctx.raw.prepare('UPDATE harnesses SET created_at = ? WHERE id = ?').run(createdAt, row.id);
  return row.id;
}

function review(ctx: Ctx, id: string, body: Record<string, unknown>, user = OPERATOR, blobs?: Record<string, { content: string }>) {
  stubRepo(user, A, blobs);
  return ctx.api.request(
    `/admin/listings/${id}/review`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

function reviewDiff(ctx: Ctx, id: string, user = OPERATOR) {
  stubRepo(user, A);
  return ctx.api.request(`/admin/listings/${id}/review-diff`, { headers: { Authorization: 'Bearer t' } }, ctx.env);
}

async function servedIds(ctx: Ctx): Promise<string[]> {
  stubRepo(STRANGER, A);
  const res = await ctx.api.request('/listings?kind=plan', {}, ctx.env);
  return ((await res.json()) as { results: Array<{ id: string }> }).results.map((r) => r.id);
}

describe('P-008 review approves a SHA', () => {
  it('P-008 approve records the reviewed commit + tree digest and leaves the pin as it was', async () => {
    const ctx = setup();
    const id = await publishAt(ctx, A, 1000);
    // SPEC-P-008: the push webhook (P-006) had flagged this row drifted; the
    // approval clears the flag. Seeded to 1 so a stale/absent clear is visible.
    ctx.raw.prepare('UPDATE harnesses SET drift = 1 WHERE id = ?').run(id);
    const pending = rowById(ctx, id);
    expect(pending).toMatchObject({ review_status: 'pending', approved_commit_sha: null, approved_tree_digest: null, approved_at: null, drift: 1 });

    const res = await review(ctx, id, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, id, review_status: 'approved', approved_commit_sha: A, repinned: false, retired_ids: [],
    });
    const row = rowById(ctx, id);
    expect(row).toMatchObject({
      review_status: 'approved',
      approved_commit_sha: A,
      approved_tree_digest: pending.pinned_tree_digest,
      pinned_commit_sha: A,
      pinned_tree_digest: pending.pinned_tree_digest,
      drift: 0,
    });
    expect(row.approved_at).toEqual(expect.any(Number));
    expect(await servedIds(ctx)).toEqual([id]);
  });

  it('P-008 / WI-10004625 approving the newest of three pending versions leaves exactly ONE served row', async () => {
    const ctx = setup();
    const v1 = await publishAt(ctx, A, 1000);
    const v2 = await publishAt(ctx, B, 2000);
    const v3 = await publishAt(ctx, C, 3000);
    expect(await servedIds(ctx)).toEqual([]);

    const res = await review(ctx, v3, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { retired_ids: string[] }).retired_ids.sort()).toEqual([v1, v2].sort());

    for (const old of [v1, v2]) {
      expect(rowById(ctx, old)).toMatchObject({
        review_status: 'pending',
        claim_status: 'superseded',
        superseded_by: v3,
        unlisted_reason: 'superseded_by_approved_version',
      });
      expect(rowById(ctx, old).unlisted_at).toEqual(expect.any(Number));
    }
    expect(rowById(ctx, v3)).toMatchObject({ review_status: 'approved', approved_commit_sha: C, unlisted_at: null });
    expect(await servedIds(ctx)).toEqual([v3]);
    // A retired pending version can no longer be approved into the served set.
    expect((await review(ctx, v1, { decision: 'approve' })).status).toBe(404);
  });

  it('P-008 approving a new version retires the previously approved one; a newer pending version stays queued', async () => {
    const ctx = setup();
    const v1 = await publishAt(ctx, A, 1000);
    expect((await review(ctx, v1, { decision: 'approve' })).status).toBe(200);
    const v2 = await publishAt(ctx, B, 2000);
    // v1 keeps being served while v2 waits (SPEC-P-004@2, unchanged by P-008).
    expect(await servedIds(ctx)).toEqual([v1]);
    const v3 = await publishAt(ctx, C, 3000);
    const v4 = await publishAt(ctx, D, 4000);

    const res = await review(ctx, v3, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { retired_ids: string[] }).retired_ids.sort()).toEqual([v1, v2].sort());

    expect(rowById(ctx, v1)).toMatchObject({ review_status: 'approved', claim_status: 'superseded', superseded_by: v3 });
    expect(rowById(ctx, v1).unlisted_at).toEqual(expect.any(Number));
    expect(rowById(ctx, v2).unlisted_at).toEqual(expect.any(Number));
    // v4 was published AFTER the reviewed v3: a newer candidate, not obsolete.
    expect(rowById(ctx, v4)).toMatchObject({ review_status: 'pending', unlisted_at: null, superseded_by: null });
    expect(await servedIds(ctx)).toEqual([v3]);
  });

  it('P-008 / WI-10004625 a lost race on the approve statement retires NOTHING — the EXISTS guard keeps the served version', async () => {
    const ctx = setup();
    const v1 = await publishAt(ctx, A, 1000);
    expect((await review(ctx, v1, { decision: 'approve' })).status).toBe(200);
    const v2 = await publishAt(ctx, B, 2000);
    const v3 = await publishAt(ctx, C, 3000);
    // v3 loses the race: another request unlisted it between the route's read and
    // the batch, so the approve UPDATE (…AND unlisted_at IS NULL) matches no row.
    ctx.raw.prepare("UPDATE harnesses SET unlisted_at = 9, unlisted_reason = 'raced' WHERE id = ?").run(v3);
    const v3Row = ctx.raw.prepare('SELECT created_at FROM harnesses WHERE id = ?').get(v3) as unknown as { created_at: number };

    await approveListingVersion(ctx.env.DB, {
      id: v3,
      reason: null,
      now: 5000,
      approved: { commitSha: C, treeDigest: 'f'.repeat(64) },
      repinned: false,
      retire: { github_repository_id: REPO_ID, listing_kind: 'plan', listing_ref: 'quality-plan', created_at: v3Row.created_at },
    });

    // v3 was NOT approved, so the retire statement must not have fired: the previously
    // approved v1 is still the served version and the older pending v2 is untouched.
    expect(rowById(ctx, v3)).toMatchObject({ review_status: 'pending', approved_commit_sha: null, unlisted_reason: 'raced' });
    expect(rowById(ctx, v1)).toMatchObject({ review_status: 'approved', claim_status: expect.not.stringMatching(/^superseded$/), superseded_by: null, unlisted_at: null });
    expect(rowById(ctx, v2)).toMatchObject({ review_status: 'pending', superseded_by: null, unlisted_at: null });
    expect(await servedIds(ctx)).toEqual([v1]);
  });

  it('P-008 a drifted row is re-pinned to the reviewed SHA: pinned_* and approved_* both end up at what was read', async () => {
    const ctx = setup();
    const id = await publishAt(ctx, A, 1000);
    ctx.raw.prepare('UPDATE harnesses SET drift = 1 WHERE id = ?').run(id);
    const before = rowById(ctx, id);

    const res = await review(ctx, id, { decision: 'approve', reviewed_commit_sha: C });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, approved_commit_sha: C, repinned: true });
    const row = rowById(ctx, id);
    expect(row).toMatchObject({ review_status: 'approved', pinned_commit_sha: C, approved_commit_sha: C, drift: 0 });
    expect(row.approved_tree_digest).toBe(row.pinned_tree_digest);
    // C's tree differs from A's, so the digest moved with the re-pin.
    expect(row.pinned_tree_digest).not.toBe(before.pinned_tree_digest);
    expect(row.pinned_tree_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('P-008 a reviewed SHA that already has its own active version is refused (409 version_exists), row stays pending', async () => {
    const ctx = setup();
    const v1 = await publishAt(ctx, A, 1000);
    const v2 = await publishAt(ctx, B, 2000);
    const res = await review(ctx, v1, { decision: 'approve', reviewed_commit_sha: B });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'version_exists', existing_id: v2, commit_sha: B });
    expect(rowById(ctx, v1)).toMatchObject({ review_status: 'pending', pinned_commit_sha: A, approved_commit_sha: null });
  });

  it('P-008 a re-pin that fails the Worker scan is refused with the pin code and approves nothing', async () => {
    const ctx = setup();
    const id = await publishAt(ctx, A, 1000);
    const identity = 'publisher-handle-42';
    const content = JSON.stringify({ launchSettings: { defaults: { account: identity } }, duty: `notify ${identity}` });
    const res = await review(ctx, id, { decision: 'approve', reviewed_commit_sha: E }, OPERATOR, {
      [TREES[E]![0]!.sha]: { content: btoa(content) },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; commitSha: string; hits: Array<{ path: string }> };
    expect(body).toMatchObject({ error: 'identity_leak', commitSha: E });
    expect(body.hits.map((h) => h.path)).toContain('quality-plan/listing.json');
    expect(rowById(ctx, id)).toMatchObject({
      review_status: 'pending', pinned_commit_sha: A, approved_commit_sha: null, approved_tree_digest: null, approved_at: null,
    });
  });

  it('P-008 rejects a malformed reviewed_commit_sha before touching anything', async () => {
    const ctx = setup();
    const id = await publishAt(ctx, A, 1000);
    for (const bad of ['main', 'abc', 'g'.repeat(40), 123]) {
      const res = await review(ctx, id, { decision: 'approve', reviewed_commit_sha: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_field', field: 'reviewed_commit_sha' });
    }
    expect(rowById(ctx, id).review_status).toBe('pending');
  });

  it('P-008 reject records no approved SHA and retires nothing', async () => {
    const ctx = setup();
    const v1 = await publishAt(ctx, A, 1000);
    const v2 = await publishAt(ctx, B, 2000);
    const res = await review(ctx, v2, { decision: 'reject', reason: 'not yet' });
    expect(res.status).toBe(200);
    expect(rowById(ctx, v2)).toMatchObject({ review_status: 'rejected', review_reason: 'not yet', approved_commit_sha: null, approved_tree_digest: null, approved_at: null });
    expect(rowById(ctx, v1)).toMatchObject({ review_status: 'pending', unlisted_at: null });
  });

  it('P-008 a non-self-describing policy kind approves with no pin and no approved SHA', async () => {
    const ctx = setup();
    stubGithub({ user: PUBLISHER, repo: { id: 70, private: false } });
    const published = await ctx.api.request(
      '/listings',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          github_owner: 'acme', github_name: 'learnings', github_url: 'https://github.com/acme/learnings',
          project_ref: 'acme/learnings', github_repository_id: 70, listing_kind: 'knowledge-pack',
          listing_ref: 'rails-conventions', title: 'Rails conventions knowledge pack',
        }),
      },
      ctx.env,
    );
    expect(published.status).toBe(200);
    const id = ((await published.json()) as { id: string }).id;
    const res = await review(ctx, id, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ review_status: 'approved', approved_commit_sha: null, repinned: false, retired_ids: [] });
    expect(rowById(ctx, id)).toMatchObject({ review_status: 'approved', approved_commit_sha: null, approved_tree_digest: null, approved_at: null });
  });

  it('P-008 only an operator may review or read the diff', async () => {
    const ctx = setup();
    const id = await publishAt(ctx, A, 1000);
    expect((await review(ctx, id, { decision: 'approve' }, STRANGER)).status).toBe(403);
    expect((await reviewDiff(ctx, id, STRANGER)).status).toBe(403);
    expect(rowById(ctx, id)).toMatchObject({ review_status: 'pending', approved_commit_sha: null });
  });
});

describe('P-008 review-diff', () => {
  it('P-008 the first-ever version diffs against nothing: every file is added', async () => {
    const ctx = setup();
    const id = await publishAt(ctx, A, 1000);
    const res = await reviewDiff(ctx, id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      first_version: boolean; from_commit_sha: string | null; to_commit_sha: string;
      files: Array<{ path: string; status: string }>; unchanged_count: number;
    };
    expect(body).toMatchObject({ first_version: true, from_commit_sha: null, to_commit_sha: A, unchanged_count: 0 });
    expect(body.files).toHaveLength(3);
    expect(body.files.every((f) => f.status === 'added')).toBe(true);
  });

  it('P-008 a later version diffs against the previously approved SHA: added / modified / removed, with unchanged counted', async () => {
    const ctx = setup();
    const v1 = await publishAt(ctx, A, 1000);
    expect((await review(ctx, v1, { decision: 'approve' })).status).toBe(200);
    const v2 = await publishAt(ctx, B, 2000);

    const res = await reviewDiff(ctx, v2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      first_version: boolean; from_commit_sha: string; from_listing_id: string; to_commit_sha: string;
      files: Array<{ path: string; status: string; fromSha: string | null; toSha: string | null }>; unchanged_count: number;
    };
    expect(body).toMatchObject({ first_version: false, from_commit_sha: A, from_listing_id: v1, to_commit_sha: B, unchanged_count: 1 });
    expect(body.files).toEqual([
      { path: 'quality-plan/extra.md', status: 'added', fromSha: null, toSha: '6'.repeat(40) },
      { path: 'quality-plan/notes.md', status: 'removed', fromSha: '5'.repeat(40), toSha: null },
      { path: 'quality-plan/README.md', status: 'modified', fromSha: '2'.repeat(40), toSha: '9'.repeat(40) },
    ].sort((x, y) => (x.path < y.path ? -1 : 1)));
  });

  it('P-008 refuses a row that is not pending', async () => {
    const ctx = setup();
    const id = await publishAt(ctx, A, 1000);
    expect((await review(ctx, id, { decision: 'approve' })).status).toBe(200);
    const res = await reviewDiff(ctx, id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_pending', review_status: 'approved' });
  });
});
