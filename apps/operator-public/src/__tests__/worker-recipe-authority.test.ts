/**
 * Worker-computed recipe authority — cupboard-release-pipeline-content-trust-2026-09-16
 * P-007 (D-005, D-010).
 *
 * A recipe's `authorityUnresolved` used to be a PUBLISHER claim written into
 * `recipe.json`. The Worker now fetches the pinned bytes itself and runs the SAME
 * static analysis on the script it fetched; the verdict is stored on the listing
 * row where no publisher field can reach it. Every FAILURE path reads
 * `unresolved: true` — "could not analyze" is never reported as "safe".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { deriveWorkerRecipeAuthority, type RecipeAuthorityAnalyzer } from '../content-pin.ts';
import { makeEnv, stubGithub, type GhStubTreeEntry } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A script whose dispatched tool is computed at runtime — the Worker cannot prove its effects.
const OPAQUE_SCRIPT = 'await tools.tools.invoke({ name: chosenVerb, args: {} });';
// A script that touches nothing the analyzer cannot resolve.
const CLEAN_SCRIPT = 'return 1 + 1;';

const manifest = (script: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'demo-recipe', script, ...extra });

const parts = (text: string, path = 'demo-recipe/recipe.json') => [{ path, text }];

describe('P-007 deriveWorkerRecipeAuthority — failure paths are UNRESOLVED, never safe', () => {
  const never: RecipeAuthorityAnalyzer = async () => {
    throw new Error('analyzer must not run');
  };

  it('a missing recipe.json is unresolved/recipe-manifest-missing', async () => {
    await expect(deriveWorkerRecipeAuthority([], 'demo-recipe', never)).resolves.toEqual({
      unresolved: true,
      cause: 'recipe-manifest-missing',
    });
    // A manifest at a DIFFERENT path (another package in the repo) does not count.
    await expect(
      deriveWorkerRecipeAuthority(parts(manifest(CLEAN_SCRIPT), 'other/recipe.json'), 'demo-recipe', never),
    ).resolves.toMatchObject({ unresolved: true, cause: 'recipe-manifest-missing' });
  });

  it('an unparseable or script-less manifest is unresolved/recipe-manifest-invalid', async () => {
    for (const text of ['{not json', manifest(undefined), manifest(''), manifest('   '), manifest(42), 'null']) {
      await expect(deriveWorkerRecipeAuthority(parts(text), 'demo-recipe', never), text).resolves.toEqual({
        unresolved: true,
        cause: 'recipe-manifest-invalid',
      });
    }
  });

  it('an analyzer that throws is unresolved/analyzer-unavailable — never resolved', async () => {
    await expect(
      deriveWorkerRecipeAuthority(parts(manifest(CLEAN_SCRIPT)), 'demo-recipe', never),
    ).resolves.toEqual({ unresolved: true, cause: 'analyzer-unavailable' });
  });

  it('an analyzer reporting unresolved without a cause still names one', async () => {
    const analyzer: RecipeAuthorityAnalyzer = async () => ({ unresolved: true });
    await expect(
      deriveWorkerRecipeAuthority(parts(manifest(CLEAN_SCRIPT)), 'demo-recipe', analyzer),
    ).resolves.toEqual({ unresolved: true, cause: 'analyzer-unavailable' });
  });

  it('carries the analyzer cause kind, and reads a proven-resolvable script as {false, null}', async () => {
    const opaque: RecipeAuthorityAnalyzer = async () => ({ unresolved: true, unresolvedCause: { kind: 'opaque-tool' } });
    const clean: RecipeAuthorityAnalyzer = async () => ({ unresolved: false, unresolvedCause: null });
    await expect(deriveWorkerRecipeAuthority(parts(manifest(OPAQUE_SCRIPT)), 'demo-recipe', opaque)).resolves.toEqual({
      unresolved: true,
      cause: 'opaque-tool',
    });
    await expect(deriveWorkerRecipeAuthority(parts(manifest(CLEAN_SCRIPT)), 'demo-recipe/', clean)).resolves.toEqual({
      unresolved: false,
      cause: null,
    });
  });

  it('analyzes ONLY the script bytes: a publisher authorityUnresolved claim is never an input', async () => {
    const seen: string[] = [];
    const analyzer: RecipeAuthorityAnalyzer = async (script) => {
      seen.push(script);
      return { unresolved: true, unresolvedCause: { kind: 'dynamic-dispatch-target' } };
    };
    const hostile = manifest(OPAQUE_SCRIPT, { authorityUnresolved: false, authority: { unresolved: false } });
    await expect(deriveWorkerRecipeAuthority(parts(hostile), 'demo-recipe', analyzer)).resolves.toEqual({
      unresolved: true,
      cause: 'dynamic-dispatch-target',
    });
    expect(seen).toEqual([OPAQUE_SCRIPT]);
  });
});

describe('P-007 deriveWorkerRecipeAuthority with the REAL analyzer', () => {
  it('a hostile manifest claiming authorityUnresolved:false beside an opaque script is UNRESOLVED', async () => {
    const hostile = manifest(OPAQUE_SCRIPT, { authorityUnresolved: false });
    await expect(deriveWorkerRecipeAuthority(parts(hostile), 'demo-recipe')).resolves.toEqual({
      unresolved: true,
      cause: 'dynamic-dispatch-target',
    });
  });

  it('a manifest claiming authorityUnresolved:true beside a clean script is still resolved (the claim is ignored both ways)', async () => {
    const honest = manifest(CLEAN_SCRIPT, { authorityUnresolved: true });
    await expect(deriveWorkerRecipeAuthority(parts(honest), 'demo-recipe')).resolves.toEqual({
      unresolved: false,
      cause: null,
    });
  });
});

// ---- route level: publish + re-pin against REAL SQLite with every migration applied ----

const A = 'a'.repeat(40);
const C = 'c'.repeat(40);
const REPO_ID = 8;
const PUBLISHER = { id: 5, login: 'pub' };
const OPERATOR = { id: 7, login: 'op' };

const BODY = {
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: 'https://github.com/papercupai/demo-project',
  project_ref: 'papercupai/demo-project',
  github_repository_id: REPO_ID,
};

interface AuthRow {
  id: string;
  listing_kind: string;
  review_status: string;
  pinned_commit_sha: string | null;
  authority_unresolved: number | null;
  authority_unresolved_cause: string | null;
}

function setup() {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv({ DB: db, CUPBOARD_OPERATOR_GITHUB_IDS: String(OPERATOR.id) });
  return { api: buildApi(), env, raw };
}
type Ctx = ReturnType<typeof setup>;

/** GitHub serving ONE recipe package whose `recipe.json` carries `script`. */
function stubRecipeRepo(user: { id: number; login: string }, head: string, script: string, ref = 'demo-recipe'): void {
  const text = manifest(script, { authorityUnresolved: false });
  // A distinct blob sha per commit, so a re-pin really changes the tree the Worker digests.
  const sha = head === A ? '1'.repeat(40) : '2'.repeat(40);
  const entries: GhStubTreeEntry[] = [{ path: `${ref}/recipe.json`, sha, size: text.length }];
  stubGithub({
    user,
    repo: { id: REPO_ID, private: false, permissions: { admin: true }, default_branch: 'main' },
    head: { sha: head },
    tree: { entries },
    blobs: { [sha]: { content: btoa(text) } },
  });
}

async function publish(ctx: Ctx, kind: string, ref: string) {
  return ctx.api.request(
    '/listings',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...BODY, listing_kind: kind, listing_ref: ref }),
    },
    ctx.env,
  );
}

const rows = (ctx: Ctx): AuthRow[] =>
  ctx.raw.prepare('SELECT * FROM harnesses ORDER BY created_at, id').all() as unknown as AuthRow[];

describe('P-007 publish stores the Worker verdict, not the publisher claim', () => {
  it('a hostile recipe (manifest claims authorityUnresolved:false, script is opaque) is stored unresolved', async () => {
    const ctx = setup();
    stubRecipeRepo(PUBLISHER, A, OPAQUE_SCRIPT);
    expect((await publish(ctx, 'recipe', 'demo-recipe')).status).toBe(200);
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({
      listing_kind: 'recipe',
      authority_unresolved: 1,
      authority_unresolved_cause: 'dynamic-dispatch-target',
    });
  });

  it('a clean recipe is stored resolved: authority_unresolved 0, cause NULL', async () => {
    const ctx = setup();
    stubRecipeRepo(PUBLISHER, A, CLEAN_SCRIPT);
    expect((await publish(ctx, 'recipe', 'demo-recipe')).status).toBe(200);
    expect(rows(ctx)[0]).toMatchObject({ authority_unresolved: 0, authority_unresolved_cause: null });
  });

  it('a recipe package with no recipe.json is stored unresolved/recipe-manifest-missing', async () => {
    const ctx = setup();
    stubGithub({
      user: PUBLISHER,
      repo: { id: REPO_ID, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha: A },
      tree: { entries: [{ path: 'demo-recipe/README.md', sha: '3'.repeat(40), size: 3 }] },
    });
    expect((await publish(ctx, 'recipe', 'demo-recipe')).status).toBe(200);
    expect(rows(ctx)[0]).toMatchObject({ authority_unresolved: 1, authority_unresolved_cause: 'recipe-manifest-missing' });
  });

  it('every NON-recipe kind is left NULL/NULL — authority is a recipe concept', async () => {
    const ctx = setup();
    stubGithub({
      user: PUBLISHER,
      repo: { id: REPO_ID, private: false, permissions: { admin: true }, default_branch: 'main' },
      head: { sha: A },
      tree: { entries: [{ path: 'quality-plan/plan.json', sha: '4'.repeat(40), size: 3 }] },
    });
    expect((await publish(ctx, 'plan', 'quality-plan')).status).toBe(200);
    expect(rows(ctx)[0]).toMatchObject({ listing_kind: 'plan', authority_unresolved: null, authority_unresolved_cause: null });
  });
});

describe('P-007 approving a RE-PINNED recipe recomputes the verdict from the new bytes', () => {
  async function approveAt(ctx: Ctx, id: string, reviewed: string) {
    return ctx.api.request(
      `/admin/listings/${id}/review`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', reviewed_commit_sha: reviewed }),
      },
      ctx.env,
    );
  }

  it('a clean pin re-pinned to a hostile commit becomes unresolved (the reviewed bytes win, not the old verdict)', async () => {
    const ctx = setup();
    stubRecipeRepo(PUBLISHER, A, CLEAN_SCRIPT);
    expect((await publish(ctx, 'recipe', 'demo-recipe')).status).toBe(200);
    const id = rows(ctx)[0]!.id;
    expect(rows(ctx)[0]).toMatchObject({ authority_unresolved: 0, authority_unresolved_cause: null });

    // The publisher pushed a hostile script; the operator reviewed commit C.
    stubRecipeRepo(OPERATOR, C, OPAQUE_SCRIPT);
    const res = await approveAt(ctx, id, C);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, repinned: true, approved_commit_sha: C });
    expect(rows(ctx)[0]).toMatchObject({
      review_status: 'approved',
      pinned_commit_sha: C,
      authority_unresolved: 1,
      authority_unresolved_cause: 'dynamic-dispatch-target',
    });
  });

  it('a hostile pin re-pinned to a clean commit becomes resolved and the stale cause is cleared', async () => {
    const ctx = setup();
    stubRecipeRepo(PUBLISHER, A, OPAQUE_SCRIPT);
    expect((await publish(ctx, 'recipe', 'demo-recipe')).status).toBe(200);
    const id = rows(ctx)[0]!.id;
    expect(rows(ctx)[0]).toMatchObject({ authority_unresolved: 1, authority_unresolved_cause: 'dynamic-dispatch-target' });

    stubRecipeRepo(OPERATOR, C, CLEAN_SCRIPT);
    expect((await approveAt(ctx, id, C)).status).toBe(200);
    expect(rows(ctx)[0]).toMatchObject({ pinned_commit_sha: C, authority_unresolved: 0, authority_unresolved_cause: null });
  });

  it('approving WITHOUT a re-pin keeps the publish-time verdict untouched', async () => {
    const ctx = setup();
    stubRecipeRepo(PUBLISHER, A, OPAQUE_SCRIPT);
    expect((await publish(ctx, 'recipe', 'demo-recipe')).status).toBe(200);
    const id = rows(ctx)[0]!.id;
    stubRecipeRepo(OPERATOR, A, OPAQUE_SCRIPT);
    const res = await ctx.api.request(
      `/admin/listings/${id}/review`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    expect(rows(ctx)[0]).toMatchObject({
      review_status: 'approved',
      pinned_commit_sha: A,
      authority_unresolved: 1,
      authority_unresolved_cause: 'dynamic-dispatch-target',
    });
  });
});
