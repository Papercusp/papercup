/**
 * Content pin at publish — cupboard-release-pipeline-content-trust-2026-09-16
 * P-001 (SPEC-P-001 / SPEC-P-001b), route-level through the real POST /listings
 * handler with GitHub stubbed at the fetch seam.
 *
 * D-003: the Worker records what IT computed (head sha + tree digest), never
 * what the client reported. D-005: an unpinnable package is REFUSED with a
 * named code, never published half-pinned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { canonicalTreeDigest } from '@papercusp/artifact-registry';
import { buildApi } from '../routes/index.ts';
import { PIN_BYTE_BUDGET, PIN_FILE_BUDGET, SELF_DESCRIBING_KINDS } from '../content-pin.ts';
import { makeEnv, stubGithub, STUB_HEAD_SHA, stubTreeFor, type GhStubTreeEntry } from './fake-d1.ts';

function publish(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  body: Record<string, unknown>,
) {
  return api.request(
    '/listings',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

const BASE = {
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: 'https://github.com/papercupai/demo-project',
  project_ref: 'papercupai/demo-project',
  github_repository_id: 7,
};
const REPO = { id: 7, private: false, permissions: { admin: true }, default_branch: 'main' };
const USER = { user: { id: 5, login: 'pub' } };

type Pinned = { pinned_commit_sha: string | null; pinned_tree_digest: string | null; pinned_at: number | null };

describe('P-001 content pin at publish', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  it('SPEC-P-001: pins the default-branch head + canonical digest of ONLY the in-ref blobs', async () => {
    const { env, store } = makeEnv();
    const head = 'c'.repeat(40);
    const inRef: GhStubTreeEntry[] = [
      { path: 'quality-plan/plan.json', sha: '3'.repeat(40), size: 300 },
      { path: 'quality-plan/README.md', sha: '4'.repeat(40), size: 40 },
      { path: 'quality-plan/nested/notes.md', sha: '5'.repeat(40), size: 5 },
    ];
    const entries: GhStubTreeEntry[] = [
      ...inRef,
      // Out-of-ref blob: another package in the same repo — must NOT enter the digest.
      { path: 'other-plan/plan.json', sha: '6'.repeat(40), size: 600 },
      // A sibling whose name merely STARTS with the ref — the prefix is `<ref>/`.
      { path: 'quality-plan-old/plan.json', sha: '7'.repeat(40), size: 70 },
      // Tree nodes carry no bytes; they are implied by their blobs.
      { path: 'quality-plan', sha: '8'.repeat(40), type: 'tree' },
      { path: 'quality-plan/nested', sha: '9'.repeat(40), type: 'tree' },
    ];
    stubGithub({ ...USER, repo: REPO, head: { sha: head }, tree: { entries } });

    const res = await publish(api, env, { ...BASE, listing_kind: 'plan', listing_ref: 'quality-plan' });
    expect(res.status).toBe(200);
    const rows = store.tables.harnesses as Pinned[];
    expect(rows).toHaveLength(1);
    expect(rows[0].pinned_commit_sha).toBe(head);
    expect(rows[0].pinned_tree_digest).toBe(
      await canonicalTreeDigest(inRef.map((e) => ({ path: e.path, sha: e.sha }))),
    );
    expect(typeof rows[0].pinned_at).toBe('number');
    // The digest is NOT the whole-repo digest: the out-of-ref blobs changed nothing.
    expect(rows[0].pinned_tree_digest).not.toBe(
      await canonicalTreeDigest(entries.filter((e) => e.type == null).map((e) => ({ path: e.path, sha: e.sha }))),
    );
  });

  it('SPEC-P-001b: an absent `<listing_ref>/` is refused 422 listing_ref_missing and nothing is inserted', async () => {
    const { env, store } = makeEnv();
    stubGithub({ ...USER, repo: REPO, head: { sha: STUB_HEAD_SHA }, tree: { entries: stubTreeFor('some-other-ref') } });
    const res = await publish(api, env, { ...BASE, listing_kind: 'goal', listing_ref: 'keep-green' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'listing_ref_missing', commitSha: STUB_HEAD_SHA });
    expect(store.tables.harnesses).toHaveLength(0);
  });

  it('refuses 422 tree_truncated when GitHub could not enumerate the tree', async () => {
    const { env, store } = makeEnv();
    stubGithub({ ...USER, repo: REPO, head: { sha: STUB_HEAD_SHA }, tree: { entries: stubTreeFor('aurora'), truncated: true } });
    const res = await publish(api, env, { ...BASE, listing_kind: 'theme', listing_ref: 'aurora' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'tree_truncated' });
    expect(store.tables.harnesses).toHaveLength(0);
  });

  it('refuses 422 listing_ref_too_large past the byte budget', async () => {
    const { env, store } = makeEnv();
    const entries: GhStubTreeEntry[] = [
      { path: 'big/listing.json', sha: '1'.repeat(40), size: 10 },
      { path: 'big/blob.bin', sha: '2'.repeat(40), size: PIN_BYTE_BUDGET },
    ];
    stubGithub({ ...USER, repo: REPO, head: { sha: STUB_HEAD_SHA }, tree: { entries } });
    const res = await publish(api, env, { ...BASE, listing_kind: 'rubric', listing_ref: 'big' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: 'listing_ref_too_large',
      fileCount: 2,
      byteCount: PIN_BYTE_BUDGET + 10,
      fileBudget: PIN_FILE_BUDGET,
      byteBudget: PIN_BYTE_BUDGET,
    });
    expect(store.tables.harnesses).toHaveLength(0);
  });

  it('refuses 400 github_tree_unreachable when the head ref cannot be resolved', async () => {
    const { env, store } = makeEnv();
    stubGithub({ ...USER, repo: REPO, head: { error: 403 }, tree: { entries: stubTreeFor('r') } });
    const res = await publish(api, env, { ...BASE, listing_kind: 'recipe', listing_ref: 'r' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'github_tree_unreachable', step: 'ref', status: 403 });
    expect(store.tables.harnesses).toHaveLength(0);
  });

  it('refuses 400 when the repo metadata carries no default branch', async () => {
    const { env, store } = makeEnv();
    const { default_branch: _dropped, ...noBranch } = REPO;
    stubGithub({ ...USER, repo: noBranch, head: { sha: STUB_HEAD_SHA }, tree: { entries: stubTreeFor('r') } });
    const res = await publish(api, env, { ...BASE, listing_kind: 'recipe', listing_ref: 'r' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'github_repo_unreachable', reason: 'no_default_branch' });
    expect(store.tables.harnesses).toHaveLength(0);
  });

  it('P-003 refuses identity copied into a self-describing package before insert', async () => {
    const { env, store } = makeEnv();
    const identity = 'publisher-handle-42';
    const content = JSON.stringify({
      launchSettings: { defaults: { account: identity } },
      duty: `notify ${identity}`,
    });
    const sha = '9'.repeat(40);
    stubGithub({
      ...USER,
      repo: REPO,
      head: { sha: STUB_HEAD_SHA },
      tree: { entries: [{ path: 'leaky/listing.json', sha, size: content.length }] },
      blobs: { [sha]: { content: btoa(content) } },
    });
    const res = await publish(api, env, { ...BASE, listing_kind: 'plan', listing_ref: 'leaky' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'identity_leak', commitSha: STUB_HEAD_SHA });
    expect(store.tables.harnesses).toHaveLength(0);
  });

  it('leaves a CODE kind untouched: no head/tree call, pinned_* null', async () => {
    const { env, store } = makeEnv();
    // No head/tree stub at all — the stub answers 500 to either call, so a
    // publish that reached them would fail loudly.
    stubGithub({ ...USER, repo: REPO });
    const res = await publish(api, env, { ...BASE, listing_kind: 'plugin', listing_ref: 'demo-plugin' });
    expect(res.status).toBe(200);
    const rows = store.tables.harnesses as Pinned[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pinned_commit_sha: null, pinned_tree_digest: null, pinned_at: null });
  });

  it('the self-describing set is exactly the five install-core kinds', () => {
    expect([...SELF_DESCRIBING_KINDS].sort()).toEqual(['goal', 'plan', 'recipe', 'rubric', 'theme']);
  });
});
