/**
 * Cupboard generalized /listings route tests (migration 004 / D-005 / D-008).
 *
 * Covers the listing kinds (harness/blueprint/plugin/pack), the
 * project-centric 1:N model (N listings per project remote), kind filtering,
 * and kind-aware publish validation. /harnesses back-compat is in
 * harnesses.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { makeEnv, makeListingRow, stubGithub, STUB_HEAD_SHA, stubTreeFor } from './fake-d1.ts';

function publish(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  body: Record<string, unknown>,
) {
  return api.request('/listings', {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

const BLUEPRINT_BASE = {
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: 'https://github.com/papercupai/demo-project',
  project_ref: 'papercupai/demo-project',
};

describe('Cupboard /listings — three kinds + project-centric 1:N', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  it('GET /listings returns empty on fresh db', async () => {
    const { env } = makeEnv();
    const res = await api.request('/listings', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[]; next_cursor: unknown };
    expect(body.results).toEqual([]);
    expect(body.next_cursor).toBe(null);
  });

  it('GET /listings?kind=bogus rejects an unknown kind', async () => {
    const { env } = makeEnv();
    const res = await api.request('/listings?kind=bogus', {}, env);
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('kind');
  });

  it('POST /listings rejects an unknown listing_kind', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
    const res = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'widget', listing_ref: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('listing_kind');
  });

  it('migration 024: publishes and filters a theme listing through the ordinary catalog path', async () => {
    const { env, store } = makeEnv();
    stubGithub({
      user: { id: 5, login: 'pub' },
      repo: { id: 24, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha: STUB_HEAD_SHA },
      tree: { entries: stubTreeFor('aurora') },
    });
    const res = await publish(api, env, {
      ...BLUEPRINT_BASE,
      github_repository_id: 24,
      listing_kind: 'theme',
      listing_ref: 'aurora',
      title: 'Aurora',
      description: 'A cool light theme',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { listing: { listing_kind: string; review_status: string } };
    expect(body.listing).toMatchObject({ listing_kind: 'theme', review_status: 'approved' });
    expect(store.tables.harnesses).toHaveLength(1);

    const filtered = await api.request('/listings?kind=theme', {}, env);
    expect(filtered.status).toBe(200);
    expect((await filtered.json() as { results: Array<{ listing_kind: string }> }).results)
      .toEqual([expect.objectContaining({ listing_kind: 'theme' })]);
  });

  it('POST /listings blueprint requires listing_ref', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
    const res = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('listing_ref');
  });

  it('POST /listings blueprint publishes WITHOUT a topic_hex', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false, permissions: { admin: true } } });
    const res = await publish(api, env, {
      ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint',
      listing_ref: 'web-app', title: 'Web App blueprint',
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; listing: Record<string, unknown> };
    expect(j.ok).toBe(true);
    expect(j.listing.listing_kind).toBe('blueprint');
    expect(j.listing.listing_ref).toBe('web-app');
    expect(j.listing.project_ref).toBe('papercupai/demo-project');
    expect(j.listing.topic_hex).toBe(null);
    expect(j.listing.publisher_permission).toBe('admin'); // trust signal applies to every kind
    expect(store.tables.harnesses).toHaveLength(1);
  });

  it('P-018: a blueprint publish stores + returns blueprint_kind (hive vs harness vs absent)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false, permissions: { admin: true } } });
    const bk = async (r: Response) => (await r.json() as { listing: Record<string, unknown> }).listing.blueprint_kind;
    // a HIVE blueprint (a hive template — the Hives tab)
    const hive = await publish(api, env, {
      ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint',
      listing_ref: 'work', title: 'Generic Hive', blueprint_kind: 'hive',
    });
    expect(hive.status).toBe(200);
    expect(await bk(hive)).toBe('hive');
    // a HARNESS blueprint (the Blueprints tab) — distinct listing_ref on the same repo (1:N)
    const harness = await publish(api, env, {
      ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint',
      listing_ref: 'coding', title: 'Coding', blueprint_kind: 'harness',
    });
    expect(await bk(harness)).toBe('harness');
    // an omitted/garbage value ⇒ null (lenient; never blocks a publish)
    const none = await publish(api, env, {
      ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint', listing_ref: 'mystery',
    });
    expect(await bk(none)).toBe(null);
  });

  it('migration 015: a plan stores each rubric requirement once without shifting later columns', async () => {
    const { env, store } = makeEnv();
    stubGithub({
      user: { id: 5, login: 'pub' },
      repo: { id: 8, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha: STUB_HEAD_SHA },
      tree: { entries: stubTreeFor('quality-plan') },
    });
    const requiresRubrics = [
      { rubricRef: 'quality-bar' },
      { rubricRef: 'advisory', optional: true },
    ];
    const res = await publish(api, env, {
      ...BLUEPRINT_BASE,
      github_repository_id: 8,
      listing_kind: 'plan',
      listing_ref: 'quality-plan',
      title: 'Quality Plan',
      requires_rubrics: requiresRubrics,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      review_status: string;
      listing: Record<string, unknown>;
    };
    expect(JSON.parse(body.listing.requires_rubrics as string)).toEqual(requiresRubrics);
    expect(body.review_status).toBe('pending');
    expect(body.listing).toMatchObject({
      hive_pubkey: null,
      blueprint_kind: null,
      review_status: 'pending',
      delivery_type: null,
    });
    expect(store.tables.harnesses[0]).toMatchObject(body.listing);
  });

  it('migration 016: a goal publishes as a reviewed kind with its rubric requirements intact', async () => {
    const { env, store } = makeEnv();
    stubGithub({
      user: { id: 5, login: 'pub' },
      repo: { id: 88, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha: STUB_HEAD_SHA },
      tree: { entries: stubTreeFor('keep-green') },
    });
    const requiresRubrics = [{ rubricRef: 'goal-mode-e2e' }];
    const res = await publish(api, env, {
      ...BLUEPRINT_BASE,
      github_repository_id: 88,
      listing_kind: 'goal',
      listing_ref: 'keep-green',
      title: 'Keep Green',
      requires_rubrics: requiresRubrics,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      review_status: string;
      listing: Record<string, unknown>;
    };
    expect(JSON.parse(body.listing.requires_rubrics as string)).toEqual(requiresRubrics);
    // 'goal' is a REVIEW_POLICY_KIND (fail-closed like plan): it lands PENDING.
    expect(body.review_status).toBe('pending');
    expect(body.listing).toMatchObject({ review_status: 'pending' });
    expect(store.tables.harnesses[0]).toMatchObject(body.listing);
  });

  it('a project hosts N blueprints (1:N): two listing_refs on one repo both publish', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false } });
    const a = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint', listing_ref: 'web-app' });
    const b = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint', listing_ref: 'cli-tool' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(store.tables.harnesses).toHaveLength(2);                // NOT deduped — distinct refs
    expect((await a.json() as { id: string }).id).not.toBe((await b.json() as { id: string }).id);
  });

  it('re-publishing the same (repo, kind, ref) dedups', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false } });
    const body = { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint', listing_ref: 'web-app' };
    const a = await publish(api, env, body);
    const b = await publish(api, env, body);
    expect((await b.json() as { dedup: boolean }).dedup).toBe(true);
    expect(store.tables.harnesses).toHaveLength(1);
    void a;
  });

  it('P-004 creates a new version when a self-describing ref moves to a new SHA', async () => {
    const { env, store } = makeEnv();
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    const body = { ...BLUEPRINT_BASE, github_repository_id: 8, listing_kind: 'plan', listing_ref: 'quality-plan' };
    stubGithub({
      user: { id: 5, login: 'pub' },
      repo: { id: 8, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha: first },
      tree: { entries: stubTreeFor('quality-plan') },
    });
    const a = await publish(api, env, body);
    expect(a.status).toBe(200);
    // A `plan` lands pending; stand in for the operator's review approval so the
    // first SHA is the "previously approved version" SPEC-P-004@2 talks about.
    const approvedFirst = store.tables.harnesses.find((row) => row.pinned_commit_sha === first)!;
    expect(approvedFirst.review_status).toBe('pending');
    approvedFirst.review_status = 'approved';
    stubGithub({
      user: { id: 5, login: 'pub' },
      repo: { id: 8, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha: second },
      tree: { entries: stubTreeFor('quality-plan') },
    });
    const b = await publish(api, env, body);
    expect(b.status).toBe(200);
    expect((await b.json() as { dedup?: boolean }).dedup).not.toBe(true);
    expect(store.tables.harnesses).toHaveLength(2);
    expect(store.tables.harnesses.map((row) => row.pinned_commit_sha)).toEqual(expect.arrayContaining([first, second]));
    // SPEC-P-004@2: the previously APPROVED version keeps being served while the
    // new SHA waits in review — publishing must never unlist the only installable copy.
    const oldRow = store.tables.harnesses.find((row) => row.pinned_commit_sha === first)!;
    const newRow = store.tables.harnesses.find((row) => row.pinned_commit_sha === second)!;
    expect(oldRow).toMatchObject({ review_status: 'approved', unlisted_at: null });
    expect(oldRow.claim_status).not.toBe('superseded');
    expect(newRow).toMatchObject({ review_status: 'pending', unlisted_at: null });
    const servedOld = await api.request(`/listings/${oldRow.id}`, {}, env);
    expect(servedOld.status).toBe(200);
    const hiddenNew = await api.request(`/listings/${newRow.id}`, {}, env);
    expect(hiddenNew.status).toBe(404);
    const browse = await api.request('/listings?kind=plan', {}, env);
    expect((await browse.json() as { results: Array<{ id: string }> }).results.map((r) => r.id)).toEqual([oldRow.id]);
    const exactRetry = await publish(api, env, body);
    expect((await exactRetry.json() as { dedup?: boolean }).dedup).toBe(true);
    expect(store.tables.harnesses).toHaveLength(2);
  });

  it('P-004 retires the prior version at publish only for a kind that publishes approved', async () => {
    const { env, store } = makeEnv();
    const first = 'c'.repeat(40);
    const second = 'd'.repeat(40);
    const body = { ...BLUEPRINT_BASE, github_repository_id: 10, listing_kind: 'theme', listing_ref: 'solar' };
    const stub = (sha: string) => stubGithub({
      user: { id: 5, login: 'pub' },
      repo: { id: 10, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha },
      tree: { entries: stubTreeFor('solar') },
    });
    stub(first);
    expect((await publish(api, env, body)).status).toBe(200);
    stub(second);
    expect((await publish(api, env, body)).status).toBe(200);
    expect(store.tables.harnesses).toHaveLength(2);
    expect(store.tables.harnesses.find((row) => row.pinned_commit_sha === first)).toMatchObject({
      claim_status: 'superseded',
      unlisted_reason: 'superseded_by_new_content_pin',
    });
    expect(store.tables.harnesses.find((row) => row.pinned_commit_sha === second)).toMatchObject({
      review_status: 'approved',
      unlisted_at: null,
    });
  });

  it('POST /listings plugin publishes (install kind)', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 9, private: false } });
    const res = await publish(api, env, {
      github_owner: 'papercupai', github_name: 'plugins', github_url: 'https://github.com/papercupai/plugins',
      github_repository_id: 9, listing_kind: 'plugin', listing_ref: 'slack-notify', project_ref: 'papercupai/plugins',
      title: 'Slack notify plugin',
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { listing: { listing_kind: string } }).listing.listing_kind).toBe('plugin');
    expect(store.tables.harnesses[0].topic_hex).toBe(null);
  });

  it('POST /listings with no kind defaults to harness and requires topic_hex', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 11, private: false } });
    const res = await publish(api, env, {
      github_owner: 'alice', github_name: 'r', github_url: 'https://github.com/alice/r',
      github_repository_id: 11,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('topic_hex');
  });

  it('GET /listings?kind=blueprint filters to blueprints (post-approval); bare /listings returns all kinds', async () => {
    const { env, store } = makeEnv();
    // Seed one of each kind directly.
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 20, private: false } });
    await publish(api, env, { github_owner: 'o', github_name: 'n', github_url: 'https://github.com/o/n', github_repository_id: 20, listing_kind: 'blueprint', listing_ref: 'bp1' });
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 21, private: false } });
    await publish(api, env, { github_owner: 'o', github_name: 'n2', github_url: 'https://github.com/o/n2', github_repository_id: 21, listing_kind: 'plugin', listing_ref: 'pl1' });
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 22, private: false } });
    await publish(api, env, { github_owner: 'o', github_name: 'n3', github_url: 'https://github.com/o/n3', github_repository_id: 22, topic_hex: 'a'.repeat(64) });

    // Blueprint is a review-policy kind (migration 008 / knowledge-packs D-007):
    // it publishes PENDING and is invisible to public browse until approved.
    const pending = await api.request('/listings?kind=blueprint', {}, env);
    expect((await pending.json() as { results: unknown[] }).results).toHaveLength(0);
    const bpRow = store.tables.harnesses.find((r) => r.listing_kind === 'blueprint')!;
    expect(bpRow.review_status).toBe('pending');
    bpRow.review_status = 'approved'; // operator approval (admin flow pinned in admin.test.ts)

    const bps = await api.request('/listings?kind=blueprint', {}, env);
    const bpBody = await bps.json() as { results: Array<{ listing_kind: string }> };
    expect(bpBody.results).toHaveLength(1);
    expect(bpBody.results[0].listing_kind).toBe('blueprint');

    const all = await api.request('/listings', {}, env);
    const allBody = await all.json() as { results: unknown[] };
    expect(allBody.results).toHaveLength(3);
  });

  it('/harnesses/:id 404s for a non-harness listing; /listings/:id returns it', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 30, private: false } });
    const pub = await publish(api, env, { github_owner: 'o', github_name: 'n', github_url: 'https://github.com/o/n', github_repository_id: 30, listing_kind: 'blueprint', listing_ref: 'bp' });
    const id = (await pub.json() as { id: string }).id;
    // Approve the pending blueprint so the public reads exercise the kind gate,
    // not the review gate (which has its own tests).
    store.tables.harnesses.find((r) => r.id === id)!.review_status = 'approved';

    const viaHarness = await api.request(`/harnesses/${id}`, {}, env);
    expect(viaHarness.status).toBe(404);                    // kind-pinned view rejects it

    const viaListings = await api.request(`/listings/${id}`, {}, env);
    expect(viaListings.status).toBe(200);
    expect((await viaListings.json() as { listing_kind: string }).listing_kind).toBe('blueprint');
  });

  it('a blueprint publish still rejects a private project remote', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 40, private: true } });
    const res = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 40, listing_kind: 'blueprint', listing_ref: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('private_repo_rejected');
  });

  it('a legacy learning-pack alias publish normalizes to knowledge-pack AND still lands PENDING (rename must not open a review-gate bypass)', async () => {
    // SECURITY INVARIANT (cupboard-public-release P-014): knowledge-pack is
    // instruction-carrying (REVIEW_POLICY_KINDS), so it must publish PENDING and
    // stay invisible until an operator approves. A publisher using the
    // pre-migration-011 wire alias `learning-pack` must be normalized to
    // `knowledge-pack` BEFORE the review_status decision — normalizeListingKind
    // runs at the top of the publish handler, the REVIEW_POLICY_KINDS gate below
    // it. If that order ever inverts (gate on the raw kind), `learning-pack`
    // would miss REVIEW_POLICY_KINDS and publish `approved`, surfacing an
    // instruction-carrying pack publicly with NO review. This locks the
    // normalize-then-gate order so that regression can't ship silently.
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 7, login: 'kp' }, repo: { id: 60, private: false } });
    const res = await publish(api, env, {
      github_owner: 'o', github_name: 'kp', github_url: 'https://github.com/o/kp',
      github_repository_id: 60, listing_kind: 'learning-pack', listing_ref: 'wisdom',
    });
    expect(res.status).toBe(200);
    const row = store.tables.harnesses.find((r) => r.github_repository_id === 60)!;
    expect(row.listing_kind).toBe('knowledge-pack'); // alias normalized forward
    expect(row.review_status).toBe('pending');        // review gate NOT bypassed

    // Invisible to public browse (under the canonical kind) until approval.
    const browse = await api.request('/listings?kind=knowledge-pack', {}, env);
    expect((await browse.json() as { results: unknown[] }).results).toHaveLength(0);
  });
});

describe('Cupboard /listings — authoritative pagination summary', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  it('treats an unsupported claim filter as absent instead of passing an arbitrary value to the query', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(
      makeListingRow({ id: 'unclaimed' }),
      makeListingRow({ id: 'claimed', claim_status: 'claimed' }),
    );

    const res = await api.request('/listings?claim=bogus', {}, env);
    const body = await res.json() as { results: Array<{ id: string }>; total: number };

    expect(res.status).toBe(200);
    expect(body.results.map((row) => row.id)).toEqual(['claimed', 'unclaimed']);
    expect(body.total).toBe(2);
  });

  it('keeps totals/facets corpus-accurate beyond 100 and excludes banned publishers before LIMIT', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(
      ...Array.from({ length: 102 }, (_, i) => makeListingRow({
        id: `h-${String(i).padStart(3, '0')}`,
        title: `Harness ${i}`,
        last_activity_at: 1_000 - i,
      })),
      makeListingRow({
        id: 'deep-app',
        listing_kind: 'app',
        title: 'Deep Needle App',
        project_ref: 'deep/project',
        last_activity_at: 1,
      }),
      makeListingRow({
        id: 'banned-first',
        listing_kind: 'plugin',
        publisher_device_pubkey: 'banned-key',
        last_activity_at: 2_000,
      }),
    );
    store.tables.banned_publisher_pubkeys.push({ pubkey: 'banned-key' });

    const first = await api.request('/listings?limit=100', {}, env);
    const firstBody = await first.json() as {
      results: Array<{ id: string }>;
      next_cursor: string | null;
      total: number;
      kind_facets: Record<string, number>;
    };
    expect(firstBody.results).toHaveLength(100);
    expect(firstBody.results.some((row) => row.id === 'deep-app')).toBe(false);
    expect(firstBody.results.some((row) => row.id === 'banned-first')).toBe(false);
    expect(firstBody.next_cursor).toMatch(/^v1:/);
    expect(firstBody.total).toBe(103);
    expect(firstBody.kind_facets.harness).toBe(102);
    expect(firstBody.kind_facets.app).toBe(1);
    expect(firstBody.kind_facets.plugin).toBe(0);

    const second = await api.request(
      `/listings?limit=100&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
      {},
      env,
    );
    const secondBody = await second.json() as typeof firstBody;
    expect(secondBody.results.map((row) => row.id)).toEqual(['h-100', 'h-101', 'deep-app']);
    expect(secondBody.next_cursor).toBe(null);
    expect(secondBody.total).toBe(103);

    const app = await api.request('/listings?kind=app&limit=100', {}, env);
    const appBody = await app.json() as typeof firstBody;
    expect(appBody.results.map((row) => row.id)).toEqual(['deep-app']);
    expect(appBody.total).toBe(1);
    // Facets omit their own kind filter, so they remain drill-down promises.
    expect(appBody.kind_facets.harness).toBe(102);
    expect(appBody.kind_facets.app).toBe(1);

    const search = await api.request('/listings?q=needle&limit=100', {}, env);
    const searchBody = await search.json() as typeof firstBody;
    expect(searchBody.results.map((row) => row.id)).toEqual(['deep-app']);
    expect(searchBody.total).toBe(1);
    expect(searchBody.kind_facets.app).toBe(1);

    const project = await api.request('/listings?project=deep%2Fproject&limit=100', {}, env);
    const projectBody = await project.json() as typeof firstBody;
    expect(projectBody.results.map((row) => row.id)).toEqual(['deep-app']);
    expect(projectBody.total).toBe(1);
    expect(projectBody.kind_facets.app).toBe(1);

    const claimed = await api.request('/listings?claim=claimed&limit=100', {}, env);
    const claimedBody = await claimed.json() as typeof firstBody;
    expect(claimedBody.results).toEqual([]);
    expect(claimedBody.total).toBe(0);
    expect(Object.values(claimedBody.kind_facets).every((count) => count === 0)).toBe(true);
  });

  it('walks equal-timestamp rows exactly once with the composite cursor', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(
      makeListingRow({ id: 'a', last_activity_at: 50 }),
      makeListingRow({ id: 'b', last_activity_at: 50 }),
      makeListingRow({ id: 'c', last_activity_at: 50 }),
    );

    const first = await api.request('/listings?limit=2', {}, env);
    const firstBody = await first.json() as { results: Array<{ id: string }>; next_cursor: string };
    expect(firstBody.results.map((row) => row.id)).toEqual(['a', 'b']);

    const second = await api.request(
      `/listings?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
      {},
      env,
    );
    const secondBody = await second.json() as { results: Array<{ id: string }>; next_cursor: null };
    expect(secondBody.results.map((row) => row.id)).toEqual(['c']);
    expect(secondBody.next_cursor).toBe(null);
  });
});

describe('Cupboard /listings — pack kind + provides_tools (migration 006)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  const PACK_BASE = {
    github_owner: 'papercupai',
    github_name: 'tool-packs',
    github_url: 'https://github.com/papercupai/tool-packs',
    project_ref: 'papercupai/tool-packs',
  };

  it('POST /listings pack publishes with provides_tools; GET returns the JSON passthrough', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 50, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 50, listing_kind: 'pack',
      listing_ref: 'markdown-tools', title: 'Markdown tools pack',
      provides_tools: ['md.render', 'md.lint'],
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; id: string; listing: Record<string, unknown> };
    expect(j.ok).toBe(true);
    // Migration 010 (P-003): 'pack' is the canonical listing kind; the wire
    // value stores through unchanged.
    expect(j.listing.listing_kind).toBe('pack');
    expect(j.listing.provides_tools).toBe(JSON.stringify(['md.render', 'md.lint']));

    const got = await api.request(`/listings/${j.id}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json() as { provides_tools: string }).provides_tools)
      .toBe(JSON.stringify(['md.render', 'md.lint']));
  });

  it('POST /listings plugin also carries provides_tools', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 51, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 51, listing_kind: 'plugin',
      listing_ref: 'repomix', provides_tools: ['repomix.pack'],
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { listing: { provides_tools: string } }).listing.provides_tools)
      .toBe(JSON.stringify(['repomix.pack']));
  });

  it('pack kind requires listing_ref like every non-harness kind', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 52, private: false } });
    const res = await publish(api, env, { ...PACK_BASE, github_repository_id: 52, listing_kind: 'pack' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('listing_ref');
  });

  it('provides_tools is rejected on non-installable kinds', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 53, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 53, listing_kind: 'blueprint',
      listing_ref: 'bp', provides_tools: ['x'],
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('provides_tools');
    expect(j.reason).toBe('plugin_or_pack_kind_only');
  });

  it('provides_tools rejects bad shapes: non-array, empty array, empty strings, oversize', async () => {
    const { env } = makeEnv();
    const bad: unknown[] = [
      'not-an-array',
      [],
      [''],
      ['  '],
      [42],
      ['a'.repeat(129)],
      Array.from({ length: 201 }, (_, i) => `t${i}`),
    ];
    let userId = 100; // fresh user per publish — stay under the 5/hr per-user cap
    for (const provides_tools of bad) {
      stubGithub({ user: { id: userId++, login: 'pub' }, repo: { id: 54, private: false } });
      const res = await publish(api, env, {
        ...PACK_BASE, github_repository_id: 54, listing_kind: 'pack',
        listing_ref: 'p', provides_tools,
      });
      expect(res.status, `shape: ${JSON.stringify(provides_tools)}`).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('provides_tools');
    }
  });

  it('provides_tools is optional for pack kind (nullable column)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 55, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 55, listing_kind: 'pack', listing_ref: 'bare',
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { listing: { provides_tools: unknown } }).listing.provides_tools).toBe(null);
  });

  it('GET /listings?kind=pack filters to packs; (repo, kind, ref) dedup applies', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 56, private: false } });
    const body = { ...PACK_BASE, github_repository_id: 56, listing_kind: 'pack', listing_ref: 'dup', provides_tools: ['a.b'] };
    await publish(api, env, body);
    const again = await publish(api, env, body);
    expect((await again.json() as { dedup: boolean }).dedup).toBe(true);
    expect(store.tables.harnesses).toHaveLength(1);

    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 57, private: false } });
    await publish(api, env, { ...PACK_BASE, github_name: 'other', github_url: 'https://github.com/papercupai/other', github_repository_id: 57, listing_kind: 'plugin', listing_ref: 'pl' });

    // ?kind=pack is the canonical filter (mig 010 / P-003).
    const packs = await api.request('/listings?kind=pack', {}, env);
    const packBody = await packs.json() as { results: Array<{ listing_kind: string }> };
    expect(packBody.results).toHaveLength(1);
    expect(packBody.results[0].listing_kind).toBe('pack');

    // ?kind=tool-pack stays a working interim wire alias (normalized to pack).
    const toolPacks = await api.request('/listings?kind=tool-pack', {}, env);
    expect((await toolPacks.json() as { results: unknown[] }).results).toHaveLength(1);
  });
});

describe('Cupboard /listings — repo→Hive binding fields (migration 007 / D-004 HYBRID)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  // Raw 32-byte Ed25519 pubkey, base64 (44 chars: 43 + '=') — the hive
  // directory announce encoding.
  const HIVE_PUBKEY = 'A'.repeat(43) + '=';

  const HARNESS_BASE = {
    github_owner: 'papercupai',
    github_name: 'hive-member',
    github_url: 'https://github.com/papercupai/hive-member',
    topic_hex: 'a'.repeat(64),
  };

  it('publish WITH hive fields → create response + GET lookup return them', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 70, private: false } });
    const res = await publish(api, env, {
      ...HARNESS_BASE, github_repository_id: 70,
      hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive',
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; id: string; listing: Record<string, unknown> };
    expect(j.listing.hive_pubkey).toBe(HIVE_PUBKEY);
    expect(j.listing.hive_title).toBe('Demo Hive');

    const got = await api.request(`/listings/${j.id}`, {}, env);
    const row = await got.json() as Record<string, unknown>;
    expect(row.hive_pubkey).toBe(HIVE_PUBKEY);
    expect(row.hive_title).toBe('Demo Hive');
  });

  it('publish WITHOUT hive fields → lookup returns them null (pre-hive binding)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 71, private: false } });
    const res = await publish(api, env, { ...HARNESS_BASE, github_repository_id: 71 });
    expect(res.status).toBe(200);
    const j = await res.json() as { id: string; listing: Record<string, unknown> };
    expect(j.listing.hive_pubkey).toBe(null);
    expect(j.listing.hive_title).toBe(null);

    const binding = await api.request('/binding/71', {}, env);
    const b = await binding.json() as { exists: boolean; harness: Record<string, unknown> };
    expect(b.exists).toBe(true);
    expect(b.harness.hive_pubkey).toBe(null);
    expect(b.harness.hive_title).toBe(null);
  });

  it('one row per member repo, same hive_pubkey: any member repo lookup finds the hive', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 72, private: false } });
    await publish(api, env, {
      ...HARNESS_BASE, github_repository_id: 72,
      hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive',
    });
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 73, private: false } });
    await publish(api, env, {
      ...HARNESS_BASE, github_name: 'hive-member-2',
      github_url: 'https://github.com/papercupai/hive-member-2',
      github_repository_id: 73, topic_hex: 'b'.repeat(64),
      hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive',
    });
    expect(store.tables.harnesses).toHaveLength(2);

    for (const repoId of [72, 73]) {
      const res = await api.request(`/binding/${repoId}`, {}, env);
      const b = await res.json() as { exists: boolean; harness: Record<string, unknown> };
      expect(b.exists).toBe(true);
      expect(b.harness.hive_pubkey).toBe(HIVE_PUBKEY);
      expect(b.harness.hive_title).toBe('Demo Hive');
    }
  });

  it('rejects a malformed hive_pubkey (not 32-byte base64)', async () => {
    const { env } = makeEnv();
    const bad = ['nope', 'a'.repeat(64), HIVE_PUBKEY + '=', 'A'.repeat(44), 42, ''];
    let userId = 200; // fresh user per publish — stay under the 5/hr cap
    for (const hive_pubkey of bad) {
      stubGithub({ user: { id: userId++, login: 'pub' }, repo: { id: 74, private: false } });
      const res = await publish(api, env, { ...HARNESS_BASE, github_repository_id: 74, hive_pubkey });
      expect(res.status, `pubkey: ${JSON.stringify(hive_pubkey)}`).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('hive_pubkey');
    }
  });

  it('rejects hive_title without hive_pubkey (display sugar needs an identity)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 75, private: false } });
    const res = await publish(api, env, { ...HARNESS_BASE, github_repository_id: 75, hive_title: 'Orphan' });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('hive_title');
    expect(j.reason).toBe('requires_hive_pubkey');
  });

  it('rejects an over-long or non-string hive_title', async () => {
    const { env } = makeEnv();
    let userId = 300;
    for (const hive_title of ['x'.repeat(201), 42, '']) {
      stubGithub({ user: { id: userId++, login: 'pub' }, repo: { id: 76, private: false } });
      const res = await publish(api, env, {
        ...HARNESS_BASE, github_repository_id: 76, hive_pubkey: HIVE_PUBKEY, hive_title,
      });
      expect(res.status, `title: ${JSON.stringify(hive_title)}`).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('hive_title');
    }
  });

  it('hive_pubkey alone (no title) is accepted', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 77, private: false } });
    const res = await publish(api, env, { ...HARNESS_BASE, github_repository_id: 77, hive_pubkey: HIVE_PUBKEY });
    expect(res.status).toBe(200);
    const j = await res.json() as { listing: Record<string, unknown> };
    expect(j.listing.hive_pubkey).toBe(HIVE_PUBKEY);
    expect(j.listing.hive_title).toBe(null);
  });

  it('non-harness kinds carry hive fields too (a Hive facet listing)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 78, private: false } });
    const res = await publish(api, env, {
      github_owner: 'papercupai', github_name: 'hive-member',
      github_url: 'https://github.com/papercupai/hive-member',
      github_repository_id: 78, listing_kind: 'blueprint', listing_ref: 'web-app',
      hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive',
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { listing: Record<string, unknown> };
    expect(j.listing.listing_kind).toBe('blueprint');
    expect(j.listing.hive_pubkey).toBe(HIVE_PUBKEY);
  });
});

/* ───────────────────────────────────────────────────────────────────────
 * provides_events (migration 012 / D-003 / P-007) — the EVENT half of the
 * dependency axis. Mirrors the provides_tools block above; the extra weight is
 * on STRUCTURAL validation, because a malformed family declaration is not
 * inert: the operator resolves an awaiter's key template by family id, so a
 * family with no keyTemplate (or a duplicated family) would resolve to a key
 * nothing emits and park the awaiting agent forever. Publish is the cheap place
 * to catch that.
 * ─────────────────────────────────────────────────────────────────────── */
describe('Cupboard /listings — provides_events (migration 012)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  const PACK_BASE = {
    github_owner: 'papercupai',
    github_name: 'event-packs',
    github_url: 'https://github.com/papercupai/event-packs',
    project_ref: 'papercupai/event-packs',
  };

  const CANARY = { family: 'canary:flipped', keyTemplate: 'canary:flipped:<flag>', describe: 'a canary flag flipped' };

  it('POST /listings pack publishes with provides_events; GET returns the JSON passthrough', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 60, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 60, listing_kind: 'pack',
      listing_ref: 'canary-pack', title: 'Canary pack',
      provides_events: [CANARY],
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; id: string; listing: Record<string, unknown> };
    expect(j.ok).toBe(true);
    expect(j.listing.provides_events).toBe(JSON.stringify([CANARY]));

    const got = await api.request(`/listings/${j.id}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json() as { provides_events: string }).provides_events).toBe(JSON.stringify([CANARY]));
  });

  it('a plugin can declare BOTH provides_tools and provides_events (the two axes coexist)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 61, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 61, listing_kind: 'plugin', listing_ref: 'watcher',
      provides_tools: ['watcher.scan'],
      provides_events: [{ family: 'watcher:settled', keyTemplate: 'watcher:settled:<env>' }],
    });
    expect(res.status).toBe(200);
    const listing = (await res.json() as { listing: Record<string, unknown> }).listing;
    // The positional-bind trap: if db.ts's INSERT column order and the bind array
    // ever drift, one of these lands in the other's column. Assert BOTH.
    expect(listing.provides_tools).toBe(JSON.stringify(['watcher.scan']));
    expect(listing.provides_events).toBe(JSON.stringify([{ family: 'watcher:settled', keyTemplate: 'watcher:settled:<env>' }]));
  });

  it('omitting provides_events stores NULL (every pre-012 listing reads as "declares no events")', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 62, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 62, listing_kind: 'pack', listing_ref: 'plain-pack',
      provides_tools: ['plain.run'],
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { listing: { provides_events: unknown } }).listing.provides_events).toBeNull();
  });

  it('provides_events is rejected on non-installable kinds', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 63, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 63, listing_kind: 'blueprint', listing_ref: 'bp',
      provides_events: [CANARY],
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('provides_events');
    expect(j.reason).toBe('plugin_or_pack_kind_only');
  });

  it('rejects a family with NO keyTemplate — the exact shape that would strand an awaiter', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 64, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 64, listing_kind: 'pack', listing_ref: 'bad-1',
      provides_events: [{ family: 'x:done' }],
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('provides_events');
    expect(j.reason).toBe('key_template_non_empty_string_max_256');
  });

  it('rejects a DUPLICATE family within one unit (ambiguous "who provides X?")', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 65, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 65, listing_kind: 'pack', listing_ref: 'bad-2',
      provides_events: [CANARY, { family: 'canary:flipped', keyTemplate: 'other:<x>' }],
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { reason: string }).reason).toBe('duplicate_family');
  });

  it('rejects bad shapes: non-array, empty array, non-object entries, empty family', async () => {
    const { env } = makeEnv();
    const cases: Array<[unknown, string]> = [
      ['not-an-array', 'array_1_to_200'],
      [[], 'array_1_to_200'],
      [['just-a-string'], 'entries_must_be_objects'],
      [[{ family: '', keyTemplate: 'k' }], 'family_non_empty_string_max_128'],
      [[{ family: 'a'.repeat(129), keyTemplate: 'k' }], 'family_non_empty_string_max_128'],
    ];
    let repoId = 70;
    for (const [value, reason] of cases) {
      stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: repoId, private: false } });
      const res = await publish(api, env, {
        ...PACK_BASE, github_repository_id: repoId, listing_kind: 'pack',
        listing_ref: `bad-${repoId}`, provides_events: value,
      });
      expect(res.status, `value=${JSON.stringify(value)}`).toBe(400);
      const j = await res.json() as { field: string; reason: string };
      expect(j.field).toBe('provides_events');
      expect(j.reason, `value=${JSON.stringify(value)}`).toBe(reason);
      repoId++;
    }
  });
});

/**
 * requires_events (migration 013 / D-003 / P-008) — the CONSUMER half of the
 * event axis. Mirrors the provides_events block above.
 *
 * The stakes differ from provides_events, and the tests say so: a REQUIRED family
 * that nothing provides is a HARD install failure (P-007's gate refuses the
 * install outright). The declaration therefore has to travel WITH the listing, or
 * the user meets that refusal as a surprise toast after clicking Install instead
 * of reading it on the detail page beforehand.
 *
 * What the worker deliberately does NOT validate: whether anything actually
 * provides the required family. The Cupboard has no host catalog and no idea what
 * the installing box already has — availability is the operator resolver's answer,
 * at install time, against the local catalog. Enforcing resolvability at publish
 * would reject a good unit whose provider merely hasn't been published yet.
 */
describe('Cupboard /listings — requires_events (migration 013)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  const PACK_BASE = {
    github_owner: 'papercupai',
    github_name: 'dep-packs',
    github_url: 'https://github.com/papercupai/dep-packs',
    project_ref: 'papercupai/dep-packs',
  };

  it('POST /listings publishes requires_events; GET returns the JSON passthrough', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 80, private: false } });
    const deps = [{ family: 'deploy:done' }, { family: 'canary:flipped', optional: true }];
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 80, listing_kind: 'pack',
      listing_ref: 'reactor', title: 'Reactor pack',
      requires_events: deps,
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; id: string; listing: Record<string, unknown> };
    expect(j.ok).toBe(true);
    // `optional` is stored only when true — an absent flag means REQUIRED.
    expect(j.listing.requires_events).toBe(
      JSON.stringify([{ family: 'deploy:done' }, { family: 'canary:flipped', optional: true }]),
    );

    const got = await api.request(`/listings/${j.id}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json() as { requires_events: string }).requires_events).toBe(
      JSON.stringify([{ family: 'deploy:done' }, { family: 'canary:flipped', optional: true }]),
    );
  });

  it('a unit can PROVIDE and REQUIRE events at once, alongside provides_tools (all three columns land)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 81, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 81, listing_kind: 'plugin', listing_ref: 'relay',
      provides_tools: ['relay.send'],
      provides_events: [{ family: 'relay:sent', keyTemplate: 'relay:sent:<id>' }],
      requires_events: [{ family: 'deploy:done' }],
    });
    expect(res.status).toBe(200);
    const listing = (await res.json() as { listing: Record<string, unknown> }).listing;
    // THE POSITIONAL-BIND TRAP, now three columns wide: db.ts's INSERT column
    // order and its bind array must stay in lockstep (and fake-d1's destructure
    // with them). If any drifts, one of these lands in another's column — and the
    // tests would keep passing while writing wrong data into wrong columns unless
    // we assert all three, distinctly, here.
    expect(listing.provides_tools).toBe(JSON.stringify(['relay.send']));
    expect(listing.provides_events).toBe(JSON.stringify([{ family: 'relay:sent', keyTemplate: 'relay:sent:<id>' }]));
    expect(listing.requires_events).toBe(JSON.stringify([{ family: 'deploy:done' }]));
  });

  it('omitting requires_events stores NULL (every pre-013 listing reads as "declares no event deps")', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 82, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 82, listing_kind: 'pack', listing_ref: 'plain',
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { listing: { requires_events: unknown } }).listing.requires_events).toBeNull();
  });

  it('requires_events is rejected on non-installable kinds', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 83, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 83, listing_kind: 'blueprint', listing_ref: 'bp',
      requires_events: [{ family: 'deploy:done' }],
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('requires_events');
    expect(j.reason).toBe('plugin_or_pack_kind_only');
  });

  it('rejects a DUPLICATE family — is the dep hard or soft? refuse to guess', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: 84, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 84, listing_kind: 'pack', listing_ref: 'dup',
      requires_events: [{ family: 'deploy:done' }, { family: 'deploy:done', optional: true }],
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('requires_events');
    expect(j.reason).toBe('duplicate_family');
  });

  it('rejects the malformed shapes', async () => {
    const cases: Array<[unknown, string]> = [
      ['nope', 'array_1_to_200'],
      [[], 'array_1_to_200'],
      [['just-a-string'], 'entries_must_be_objects'],
      [[{ family: '' }], 'family_non_empty_string_max_128'],
      [[{ family: 'a'.repeat(129) }], 'family_non_empty_string_max_128'],
      [[{ family: 'ok:done', optional: 'yes' }], 'optional_must_be_boolean'],
    ];
    let repoId = 90;
    for (const [value, reason] of cases) {
      // A FRESH env per case, deliberately: the publish rate limit (5/hr) is
      // enforced BEFORE field validation, so even these rejected attempts count
      // against it — six cases sharing one env would make the last ones 429
      // rather than 400, and the test would be asserting the rate limiter instead
      // of the validator it is named for.
      const { env } = makeEnv();
      stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: repoId, private: false } });
      const res = await publish(api, env, {
        ...PACK_BASE, github_repository_id: repoId, listing_kind: 'pack',
        listing_ref: `bad-${repoId}`, requires_events: value,
      });
      expect(res.status, `value=${JSON.stringify(value)}`).toBe(400);
      const j = await res.json() as { field: string; reason: string };
      expect(j.field).toBe('requires_events');
      expect(j.reason, `value=${JSON.stringify(value)}`).toBe(reason);
      repoId++;
    }
  });
});

// App distribution (migration 014 / cupboard-app-distribution-2026-07-14 P-003):
// the kind='app' publish path. A STANDALONE app is a separate downloadable
// product — the Cupboard stores its latest.json handoff url + the denormalized
// platform keys and never re-hosts the binary. `app` is fail-closed
// (REVIEW_POLICY_KINDS) so it publishes PENDING.
const APP_BASE = {
  github_owner: 'acme',
  github_name: 'oddsmith',
  github_url: 'https://github.com/acme/oddsmith',
  project_ref: 'acme/oddsmith',
};
const LATEST_JSON = 'https://github.com/acme/oddsmith/releases/latest/download/latest.json';

describe('Cupboard /listings — kind=app (standalone distribution)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  it('publishes a standalone app: stores delivery/url/platforms + lands PENDING (fail-closed)', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 40, private: false, permissions: { admin: true } } });
    const res = await publish(api, env, {
      ...APP_BASE, github_repository_id: 40, listing_kind: 'app', listing_ref: 'oddsmith',
      title: 'Oddsmith', delivery_type: 'standalone', latest_json_url: LATEST_JSON,
      release_repo: 'acme/oddsmith-releases', icon_url: 'https://acme.dev/icon.png',
      platforms: ['darwin-aarch64', 'linux-x86_64'],
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; review_status: string; pending_review?: boolean; listing: Record<string, unknown> };
    expect(j.ok).toBe(true);
    expect(j.review_status).toBe('pending');       // app is fail-closed
    expect(j.pending_review).toBe(true);
    expect(j.listing.listing_kind).toBe('app');
    expect(j.listing.delivery_type).toBe('standalone');
    expect(j.listing.latest_json_url).toBe(LATEST_JSON);
    expect(j.listing.release_repo).toBe('acme/oddsmith-releases');
    expect(j.listing.icon_url).toBe('https://acme.dev/icon.png');
    expect(j.listing.platforms).toBe(JSON.stringify(['darwin-aarch64', 'linux-x86_64']));
    expect(store.tables.harnesses).toHaveLength(1);
  });

  it('defaults delivery_type to standalone (still requires latest_json_url)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 41, private: false } });
    const res = await publish(api, env, {
      ...APP_BASE, github_repository_id: 41, listing_kind: 'app', listing_ref: 'oddsmith',
      latest_json_url: LATEST_JSON,
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { listing: Record<string, unknown> };
    // stored delivery_type stays null (⇒ treated as standalone downstream)
    expect(j.listing.delivery_type).toBe(null);
    expect(j.listing.latest_json_url).toBe(LATEST_JSON);
  });

  it('rejects a standalone app with no latest_json_url (a dead download)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 42, private: false } });
    const res = await publish(api, env, {
      ...APP_BASE, github_repository_id: 42, listing_kind: 'app', listing_ref: 'oddsmith',
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('latest_json_url');
    expect(j.reason).toBe('required_for_standalone_app');
  });

  it('rejects app fields on a NON-app kind (app_kind_only)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 43, private: false } });
    const res = await publish(api, env, {
      ...APP_BASE, github_repository_id: 43, listing_kind: 'blueprint', listing_ref: 'x',
      latest_json_url: LATEST_JSON,
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('app_fields');
    expect(j.reason).toBe('app_kind_only');
  });

  it('rejects malformed app field shapes', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ delivery_type: 'weird' }, 'delivery_type', 'standalone_or_bundle'],
      [{ latest_json_url: 'http://insecure/latest.json' }, 'latest_json_url', 'https_url_max_500'],
      [{ latest_json_url: LATEST_JSON, release_repo: 'not-a-repo' }, 'release_repo', 'owner_slash_repo'],
      [{ latest_json_url: LATEST_JSON, icon_url: 'ftp://x/icon.png' }, 'icon_url', 'https_url_max_500'],
      [{ latest_json_url: LATEST_JSON, platforms: [] }, 'platforms', 'array_1_to_20'],
      [{ latest_json_url: LATEST_JSON, platforms: ['ok', ''] }, 'platforms', 'non_empty_strings_max_64'],
    ];
    let repoId = 50;
    for (const [extra, field, reason] of cases) {
      // Fresh env per case (the 5/hr publish cap runs BEFORE field validation).
      const { env } = makeEnv();
      stubGithub({ user: { id: 6, login: 'pub' }, repo: { id: repoId, private: false } });
      const res = await publish(api, env, {
        ...APP_BASE, github_repository_id: repoId, listing_kind: 'app',
        listing_ref: `oddsmith-${repoId}`, ...extra,
      });
      expect(res.status, `extra=${JSON.stringify(extra)}`).toBe(400);
      const j = await res.json() as { field: string; reason: string };
      expect(j.field, `extra=${JSON.stringify(extra)}`).toBe(field);
      expect(j.reason, `extra=${JSON.stringify(extra)}`).toBe(reason);
      repoId++;
    }
  });
});
