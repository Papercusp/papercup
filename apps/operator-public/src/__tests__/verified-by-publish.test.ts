/**
 * P-010 (SPEC-P-010 / SPEC-P-010b, R-6) — `verified_by` through the REAL POST /listings handler.
 *
 * The positive case is unmocked end to end: GitHub is stubbed at the fetch seam, the stubbed
 * tree is the exact `<ref>/` the Papercusp/cupboard-actions selftest attested, so the digest the
 * WORKER computes from the stubbed tree equals the digest inside a REAL Sigstore bundle
 * (fixtures/attestation/api-reply.json), and the real `@sigstore/verify` chain accepts it.
 *
 * The badge is a label on a row the Worker already trusts for its own reasons: every negative
 * below still publishes (200) and stores 'worker'.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import reply from './fixtures/attestation/api-reply.json';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub, type GhStubTreeEntry } from './fake-d1.ts';

// What the real selftest run attested (see attestation.test.ts): path
// `fixtures/sample-recipe/recipe.json` at blob 3263ebea…, commit 367edea….
const ATTESTED_COMMIT = '367edea41439ed08f471094bfcc18febe1a0d93c';
const ATTESTED_DIGEST = '1c51ad1f39ab6096c9b419fba6bce95516e59018aa2fca25bc49248a13a61205';
const RECIPE_REF = 'fixtures/sample-recipe';
const RECIPE_BLOB_SHA = '3263ebea78ccb06c758f73c457a0c360248f858c';
const RECIPE_JSON = JSON.stringify({
  id: 'cupboard-actions-selftest',
  title: 'Cupboard actions self-test fixture',
  version: '1.0.0',
  kind: 'recipe',
});

const REPO = { id: 7, private: false, permissions: { admin: true }, default_branch: 'main' };
const USER = { user: { id: 5, login: 'pub' } };
const BASE = {
  github_owner: 'Papercusp',
  github_name: 'cupboard-actions',
  github_url: 'https://github.com/Papercusp/cupboard-actions',
  project_ref: 'Papercusp/cupboard-actions',
  github_repository_id: 7,
};

type Row = { verified_by: string; pinned_tree_digest: string | null; pinned_commit_sha: string | null };
type AttestationMode = 'fixture' | 'not-found' | 'github-down';

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

/** Stub GitHub for a recipe publish, then front it with the attestations endpoint (the stub's
 *  catch-all would otherwise answer `/repos/…/attestations/…` with the repo document). */
function stubPublishWorld(mode: AttestationMode, extraEntries: GhStubTreeEntry[] = []): string[] {
  const entries: GhStubTreeEntry[] = [
    { path: `${RECIPE_REF}/recipe.json`, sha: RECIPE_BLOB_SHA, size: RECIPE_JSON.length },
    ...extraEntries,
  ];
  stubGithub({
    ...USER,
    repo: REPO,
    head: { sha: ATTESTED_COMMIT },
    tree: { entries },
    blobs: { [RECIPE_BLOB_SHA]: { content: btoa(RECIPE_JSON) } },
  });
  const githubStub = globalThis.fetch;
  const attestationUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (!u.includes('/attestations/')) return githubStub(url, init);
    attestationUrls.push(u);
    if (mode === 'github-down') throw new Error('connect ECONNREFUSED api.github.com');
    if (mode === 'not-found') return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return attestationUrls;
}

describe('P-010 verified_by at publish', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  it('SPEC-P-010: a genuine attestation over the tree the WORKER pinned stores verified_by=attestation', async () => {
    const { env, store } = makeEnv();
    const asked = stubPublishWorld('fixture');
    const res = await publish(api, env, { ...BASE, listing_kind: 'recipe', listing_ref: RECIPE_REF });
    expect(res.status).toBe(200);
    const [row] = store.tables.harnesses as Row[];
    // The Worker pinned the bytes itself first; the badge rides on top of that pin.
    expect(row.pinned_tree_digest).toBe(ATTESTED_DIGEST);
    expect(row.pinned_commit_sha).toBe(ATTESTED_COMMIT);
    expect(row.verified_by).toBe('attestation');
    // It asked GitHub about the digest the Worker COMPUTED, in the publisher's repo.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/repos/Papercusp/cupboard-actions/attestations/');
    expect(asked[0]).toContain(`sha256:${ATTESTED_DIGEST}`);
  });

  it('SPEC-P-010b: a publisher with NO attestation still publishes, as worker-verified', async () => {
    const { env, store } = makeEnv();
    stubPublishWorld('not-found');
    const res = await publish(api, env, { ...BASE, listing_kind: 'recipe', listing_ref: RECIPE_REF });
    expect(res.status).toBe(200);
    expect((store.tables.harnesses as Row[])[0].verified_by).toBe('worker');
  });

  it('SPEC-P-010b: GitHub being unreachable for the attestation lookup never blocks the publish', async () => {
    const { env, store } = makeEnv();
    stubPublishWorld('github-down');
    const res = await publish(api, env, { ...BASE, listing_kind: 'recipe', listing_ref: RECIPE_REF });
    expect(res.status).toBe(200);
    const [row] = store.tables.harnesses as Row[];
    expect(row.verified_by).toBe('worker');
    // …and the Worker's own pin is intact: only the badge was lost.
    expect(row.pinned_tree_digest).toBe(ATTESTED_DIGEST);
  });

  it('R-6: an attestation for a DIFFERENT tree than the Worker pinned never earns the badge', async () => {
    const { env, store } = makeEnv();
    // One extra blob the attested tree never contained: the Worker's digest moves, while the
    // (replayed) genuine bundle still attests the old digest. The badge must not follow it.
    stubPublishWorld('fixture', [{ path: `${RECIPE_REF}/extra.json`, sha: '9'.repeat(40), size: 2 }]);
    const res = await publish(api, env, { ...BASE, listing_kind: 'recipe', listing_ref: RECIPE_REF });
    expect(res.status).toBe(200);
    const [row] = store.tables.harnesses as Row[];
    expect(row.pinned_tree_digest).not.toBe(ATTESTED_DIGEST);
    expect(row.verified_by).toBe('worker');
  });

  it('R-6: an attestation for a DIFFERENT repo never earns the badge (a copied bundle is not provenance)', async () => {
    const { env, store } = makeEnv();
    stubPublishWorld('fixture');
    const res = await publish(api, env, {
      ...BASE,
      github_name: 'someone-elses-fork',
      github_url: 'https://github.com/Papercusp/someone-elses-fork',
      project_ref: 'Papercusp/someone-elses-fork',
      listing_kind: 'recipe',
      listing_ref: RECIPE_REF,
    });
    expect(res.status).toBe(200);
    expect((store.tables.harnesses as Row[])[0].verified_by).toBe('worker');
  });

  it('a code kind has no pin to attest: the attestation endpoint is never asked and the row is worker', async () => {
    const { env, store } = makeEnv();
    const asked = stubPublishWorld('fixture');
    const res = await publish(api, env, { ...BASE, listing_kind: 'plugin', listing_ref: 'demo-plugin' });
    expect(res.status).toBe(200);
    expect(asked).toHaveLength(0);
    expect((store.tables.harnesses as Row[])[0].verified_by).toBe('worker');
  });
});
