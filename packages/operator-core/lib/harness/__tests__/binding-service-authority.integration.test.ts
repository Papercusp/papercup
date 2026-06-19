/**
 * binding-service-authority.integration.test.ts — Brief AI (shared-hive-release-testing)
 *
 * Release-grade end-to-end + ADVERSARIAL coverage of the provisional→claimed
 * shared-hive ownership AUTHORITY model against real Postgres. Prior tests
 * (binding-service.test.ts, claim-status-resolver.test.ts, binding-claim.test.ts)
 * only exercised pure helpers + the route's *injected* claimBinding — the actual
 * service functions (createUnclaimedBinding / claimBinding / supersedeBinding /
 * recheckClaimantPermissions) had NO test against a real cache row + the GitHub
 * permission gate. This is that pass. Each S0 case is a SECURITY assertion: the
 * gate must derive authority from the live GitHub collaborator permission
 * (mocked here), keyed on the gh-token identity — never a client-supplied one.
 *
 * Mocks (the member-tier-gate.integration.test.ts pattern):
 *   - @papercusp/db-org getOrgPg → throwaway testcontainer DB
 *   - ../identity/octokit-client getOctokit → a controllable fake Octokit
 *   - ../workspace-registry activeWorkspaceId → a per-test workspace id
 *
 * Brief AI scenarios covered: 1 (create→unclaimed), 2 (verified claim), 3 (S0:
 * non-owner reject — teeth), 4 (supersede admin-only ladder), 5 (stale recheck —
 * see the AI-4 STUB finding it documents), 6 (federation guard — AI-5), 7
 * (idempotent re-claim / two-maintainer race / renamed+deleted repo / forged
 * identity).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { GithubRepoPermission } from '../binding-types';

// ── hoisted mutable GitHub + workspace state the mocks read ──────────────────
const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  ws: 'ws-owner',
  /** The gh-token identity getAuthenticatedUser() resolves to. */
  acting: { login: 'owner', id: 1 } as { login: string; id: number },
  /** When non-null, getAuthenticated() shifts from this queue (concurrency test). */
  actingQueue: null as null | Array<{ login: string; id: number }>,
  /** repos.get() result, or an HTTP error to throw (404 deleted / 403 private). */
  repo: { id: 555, full_name: 'acme/widgets', private: false } as
    | { id: number; full_name: string; private: boolean }
    | { httpStatus: number; headers?: Record<string, string> },
  /** username → permission. Missing → 404 → 'none' (non-collaborator). 'THROW' → API-down. */
  perm: {} as Record<string, GithubRepoPermission | 'THROW'>,
}));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../../identity/octokit-client', () => ({
  getOctokit: async () => ({
    users: {
      getAuthenticated: async () => {
        const a = h.actingQueue && h.actingQueue.length ? h.actingQueue.shift()! : h.acting;
        return { data: { login: a.login, id: a.id } };
      },
    },
    repos: {
      get: async () => {
        const r = h.repo as { httpStatus?: number; headers?: Record<string, string>; id?: number; full_name?: string; private?: boolean };
        if (typeof r.httpStatus === 'number') {
          const err = new Error('gh repos.get error') as Error & { status?: number; response?: { headers?: Record<string, string> } };
          err.status = r.httpStatus;
          if (r.headers) err.response = { headers: r.headers };
          throw err;
        }
        return { data: { id: r.id, full_name: r.full_name, private: !!r.private } };
      },
      getCollaboratorPermissionLevel: async (args: { owner: string; repo: string; username: string }) => {
        const p = h.perm[args.username];
        if (p === undefined) {
          const err = new Error('not a collaborator') as Error & { status?: number };
          err.status = 404; // → getRepoPermission returns 'none'
          throw err;
        }
        if (p === 'THROW') {
          const err = new Error('github down') as Error & { status?: number };
          err.status = 500;
          throw err;
        }
        return { data: { permission: p } };
      },
    },
  }),
}));

const svc = await import('../binding-service');
const { BindingServiceErrorThrowable } = await import('../binding-types');

let db: FreshPgDb;

const DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.shared_repo_binding_cache (
    workspace_id text DEFAULT '' NOT NULL,
    provider text DEFAULT 'github' NOT NULL,
    github_repository_id bigint NOT NULL,
    github_full_name text NOT NULL,
    harness_topic text NOT NULL,
    harness_slug text NOT NULL,
    harness_link text NOT NULL,
    privacy text NOT NULL,
    claim_status text DEFAULT 'unclaimed' NOT NULL,
    provisional_owner_github_user_id bigint NOT NULL,
    provisional_owner_github_login text DEFAULT '' NOT NULL,
    claimed_by_github_user_ids bigint[] DEFAULT '{}' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    claimed_at timestamptz,
    last_permission_verified_at timestamptz,
    superseded_by_harness_topic text,
    cached_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (workspace_id, provider, github_repository_id),
    CONSTRAINT srbc_claim_status_check CHECK (claim_status = ANY (ARRAY['unclaimed','claimed','stale','superseded'])),
    CONSTRAINT srbc_privacy_check CHECK (privacy = ANY (ARRAY['shared-private','shared-public'])),
    CONSTRAINT srbc_provider_check CHECK (provider = 'github')
  );
  CREATE TABLE IF NOT EXISTS harness_shared.contributors (
    workspace_id text NOT NULL,
    github_user_id bigint NOT NULL,
    github_username text NOT NULL
  );`;

/** Seed a numeric-id → login row so recheckClaimantPermissions can resolve it. */
async function seedContributor(githubUserId: number, login: string) {
  await db.sql`INSERT INTO harness_shared.contributors (workspace_id, github_user_id, github_username)
               VALUES (${h.ws}, ${githubUserId}, ${login})`;
}

const TOPIC = 'a'.repeat(64);
const TOPIC2 = 'b'.repeat(64);

/** Read the raw cache row back for assertions. */
async function rawRow(repoId = 555) {
  const rows = (await db.sql`
    SELECT claim_status, provisional_owner_github_user_id, provisional_owner_github_login,
           claimed_by_github_user_ids, claimed_at, last_permission_verified_at,
           superseded_by_harness_topic, harness_slug, harness_topic, github_full_name
      FROM harness_shared.shared_repo_binding_cache
     WHERE workspace_id = ${h.ws} AND provider = 'github' AND github_repository_id = ${repoId}
     LIMIT 1`) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

async function createUnclaimed(over: { login?: string; id?: number } = {}) {
  h.acting = { login: over.login ?? 'owner', id: over.id ?? 1 };
  return svc.createUnclaimedBinding({
    githubUrl: 'https://github.com/acme/widgets',
    privacy: 'shared-private',
    harness_topic: TOPIC,
    harness_slug: 'widgets',
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('binding-authority');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 120_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.shared_repo_binding_cache, harness_shared.contributors`;
  h.ws = 'ws-owner';
  h.acting = { login: 'owner', id: 1 };
  h.actingQueue = null;
  h.repo = { id: 555, full_name: 'acme/widgets', private: false };
  h.perm = {};
});

// ── Scenario 1: create → provisional → unclaimed (the default) ───────────────
describe('createUnclaimedBinding (Brief AI scenario 1)', () => {
  it('records the creator as provisional owner with claim_status=unclaimed', async () => {
    const rec = await createUnclaimed({ login: 'alice', id: 10 });
    expect(rec.claim_status).toBe('unclaimed');
    expect(rec.provisional_owner_github_user_id).toBe(10);
    expect(rec.provisional_owner_github_login).toBe('alice');
    expect(rec.claimed_by_github_user_ids).toEqual([]);
    const row = await rawRow();
    expect(row?.claim_status).toBe('unclaimed');
    expect(Number(row?.provisional_owner_github_user_id)).toBe(10);
  });

  it('rejects a second create on an already-active binding (BINDING_EXISTS)', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    await expect(createUnclaimed({ login: 'bob', id: 20 })).rejects.toMatchObject({
      error: { code: 'BINDING_EXISTS' },
    });
  });

  it('allows re-create once the prior binding is superseded', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    await db.sql`UPDATE harness_shared.shared_repo_binding_cache SET claim_status='superseded'`;
    const rec = await createUnclaimed({ login: 'bob', id: 20 });
    expect(rec.claim_status).toBe('unclaimed');
    expect(rec.provisional_owner_github_user_id).toBe(20);
  });
});

// ── Scenario 2 + 3: verified claim, and the S0 non-owner reject ──────────────
describe('claimBinding — the authority gate (Brief AI scenarios 2 & 3)', () => {
  beforeEach(async () => {
    await createUnclaimed({ login: 'alice', id: 10 }); // provisional owner alice
  });

  it('scenario 2 — an admin claims → unclaimed→claimed, claimant appended, timestamps set', async () => {
    h.acting = { login: 'carol', id: 30 };
    h.perm = { carol: 'admin' };
    const rec = await svc.claimBinding({ binding_id: 'github:555' });
    expect(rec.claim_status).toBe('claimed');
    expect(rec.claimed_by_github_user_ids).toEqual([30]);
    expect(rec.claimed_at).toBeTruthy();
    expect(rec.last_permission_verified_at).toBeTruthy();
    const row = await rawRow();
    expect(row?.claim_status).toBe('claimed');
    expect((row?.claimed_by_github_user_ids as number[]).map(Number)).toEqual([30]);
  });

  it('a maintain-level user can also claim (maintain satisfies the gate)', async () => {
    h.acting = { login: 'mara', id: 40 };
    h.perm = { mara: 'maintain' };
    const rec = await svc.claimBinding({ binding_id: 'github:555' });
    expect(rec.claim_status).toBe('claimed');
    expect(rec.claimed_by_github_user_ids).toEqual([40]);
  });

  it('S0 — a write-level user is REJECTED (write is NOT enough) and status stays unclaimed', async () => {
    h.acting = { login: 'wendy', id: 50 };
    h.perm = { wendy: 'write' };
    await expect(svc.claimBinding({ binding_id: 'github:555' })).rejects.toMatchObject({
      error: { code: 'CLAIM_PERMISSION_DENIED', actual: 'write' },
    });
    expect((await rawRow())?.claim_status).toBe('unclaimed');
  });

  it('S0 — a read-level user is REJECTED and status stays unclaimed', async () => {
    h.acting = { login: 'rob', id: 60 };
    h.perm = { rob: 'read' };
    await expect(svc.claimBinding({ binding_id: 'github:555' })).rejects.toMatchObject({
      error: { code: 'CLAIM_PERMISSION_DENIED', actual: 'read' },
    });
    expect((await rawRow())?.claim_status).toBe('unclaimed');
  });

  it('S0 — a non-collaborator (perm none / 404) is REJECTED', async () => {
    h.acting = { login: 'stranger', id: 70 };
    h.perm = {}; // 404 → 'none'
    await expect(svc.claimBinding({ binding_id: 'github:555' })).rejects.toMatchObject({
      error: { code: 'CLAIM_PERMISSION_DENIED', actual: 'none' },
    });
    expect((await rawRow())?.claim_status).toBe('unclaimed');
  });

  it('claim on an unknown repo id → BINDING_NOT_FOUND', async () => {
    h.acting = { login: 'carol', id: 30 };
    h.perm = { carol: 'admin' };
    await expect(svc.claimBinding({ binding_id: 'github:999999' })).rejects.toMatchObject({
      error: { code: 'BINDING_NOT_FOUND' },
    });
  });

  it('claim on a superseded binding → BINDING_NOT_CLAIMABLE', async () => {
    await db.sql`UPDATE harness_shared.shared_repo_binding_cache SET claim_status='superseded'`;
    h.acting = { login: 'carol', id: 30 };
    h.perm = { carol: 'admin' };
    await expect(svc.claimBinding({ binding_id: 'github:555' })).rejects.toMatchObject({
      error: { code: 'BINDING_NOT_CLAIMABLE' },
    });
  });
});

// ── Scenario 7: idempotent re-claim / second maintainer / race ───────────────
describe('claimBinding — multi-claimant + idempotency (Brief AI scenario 7)', () => {
  beforeEach(async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
  });

  it('idempotent re-claim by the same user → no duplicate claimant', async () => {
    h.acting = { login: 'carol', id: 30 };
    h.perm = { carol: 'admin' };
    await svc.claimBinding({ binding_id: 'github:555' });
    const second = await svc.claimBinding({ binding_id: 'github:555' });
    expect(second.claimed_by_github_user_ids).toEqual([30]); // not [30,30]
    expect(second.claim_status).toBe('claimed');
  });

  it('a second authorized maintainer (sequential) is appended → both recorded', async () => {
    h.perm = { carol: 'admin', dave: 'maintain' };
    h.acting = { login: 'carol', id: 30 };
    await svc.claimBinding({ binding_id: 'github:555' });
    h.acting = { login: 'dave', id: 40 };
    const rec = await svc.claimBinding({ binding_id: 'github:555' });
    expect(rec.claimed_by_github_user_ids.map(Number).sort()).toEqual([30, 40]);
  });

  it('two maintainers racing to claim concurrently must not corrupt the row (deterministic outcome)', async () => {
    // Both authorized. getAuthenticated() shifts from the queue so the two
    // concurrent claimBinding calls act as distinct users.
    h.perm = { carol: 'admin', dave: 'admin' };
    h.actingQueue = [
      { login: 'carol', id: 30 },
      { login: 'dave', id: 40 },
    ];
    const results = await Promise.allSettled([
      svc.claimBinding({ binding_id: 'github:555' }),
      svc.claimBinding({ binding_id: 'github:555' }),
    ]);
    // No call may throw — both users are authorized.
    for (const r of results) expect(r.status).toBe('fulfilled');
    const row = await rawRow();
    const ids = (row?.claimed_by_github_user_ids as number[]).map(Number).sort();
    // The row is never corrupt and status is claimed. Whether BOTH ids land or
    // one is lost depends on read-modify-write interleave (see AI-6); the
    // invariant we hold here is no-corruption + at-least-one + claimed.
    expect(row?.claim_status).toBe('claimed');
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.every((n) => n === 30 || n === 40)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate id
  });
});

// ── Scenario 7: forged identity is impossible (gh-token, not client-supplied) ─
describe('claim identity is the gh-token user, never client-supplied (Brief AI scenario 7)', () => {
  it('the recorded claimant is always getAuthenticatedUser() — claimBinding takes only binding_id', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    // The only input is binding_id. Identity comes from the authenticated gh-token.
    h.acting = { login: 'carol', id: 30 };
    h.perm = { carol: 'admin' };
    const rec = await svc.claimBinding({ binding_id: 'github:555' });
    expect(rec.claimed_by_github_user_ids).toEqual([30]); // carol (gh-token), nothing forgeable
  });
});

// ── Scenario 4: supersede authority ladder (admin-only) ──────────────────────
describe('supersedeBinding — the admin-only authority ladder (Brief AI scenario 4)', () => {
  beforeEach(async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
  });

  it('an admin supersedes → new row is claimed by the admin under the new topic/slug', async () => {
    h.acting = { login: 'carol', id: 30 };
    h.perm = { carol: 'admin' };
    const { old, new: created } = await svc.supersedeBinding({
      old_binding_id: 'github:555',
      new_harness_topic: TOPIC2,
      new_harness_slug: 'widgets-v2',
      reason: 'rotate',
    });
    expect(old.claim_status).toBe('superseded');
    expect(old.superseded_by_harness_topic).toBe(TOPIC2);
    expect(created.claim_status).toBe('claimed');
    expect(created.harness_topic).toBe(TOPIC2);
    expect(created.claimed_by_github_user_ids).toEqual([30]);
    const row = await rawRow();
    expect(row?.harness_topic).toBe(TOPIC2);
    expect(row?.claim_status).toBe('claimed');
  });

  it('scenario 4 — a maintain-only user CANNOT supersede (SUPERSEDE_PERMISSION_DENIED)', async () => {
    h.acting = { login: 'mara', id: 40 };
    h.perm = { mara: 'maintain' }; // enough to claim, NOT to supersede
    await expect(
      svc.supersedeBinding({ old_binding_id: 'github:555', new_harness_topic: TOPIC2, new_harness_slug: 'v2', reason: 'x' }),
    ).rejects.toMatchObject({ error: { code: 'SUPERSEDE_PERMISSION_DENIED', actual: 'maintain' } });
    // Untouched.
    expect((await rawRow())?.harness_topic).toBe(TOPIC);
  });

  it('a read/none user cannot supersede', async () => {
    h.acting = { login: 'rob', id: 60 };
    h.perm = { rob: 'read' };
    await expect(
      svc.supersedeBinding({ old_binding_id: 'github:555', new_harness_topic: TOPIC2, new_harness_slug: 'v2', reason: 'x' }),
    ).rejects.toMatchObject({ error: { code: 'SUPERSEDE_PERMISSION_DENIED' } });
  });
});

// ── Scenario 5: stale re-verification (AI-4 fix — implemented this pass) ──────
// NOTE: recheckClaimantPermissions now does the real per-claimant re-check with
// fail-SAFE semantics. (The function is still UNWIRED to a scheduled routine —
// EI-1624 — so it does not yet fire live; these tests verify the LOGIC.)
describe('recheckClaimantPermissions — stale demotion (Brief AI scenario 5)', () => {
  /** Claim github:555 as `actor` then return to a neutral state. */
  async function claimAs(login: string, id: number, perm: GithubRepoPermission = 'admin') {
    h.acting = { login, id };
    h.perm = { [login]: perm };
    await svc.claimBinding({ binding_id: 'github:555' });
  }

  it('a sole claimant who LOST repo permission → demoted → claimed→stale (the brief flip)', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    await seedContributor(30, 'carol');
    await claimAs('carol', 30, 'admin');
    h.perm = { carol: 'read' }; // carol definitively downgraded to read

    const changes = await svc.recheckClaimantPermissions();
    expect(changes).toEqual([{ binding_id: 'github:555', old_status: 'claimed', new_status: 'stale' }]);
    const row = await rawRow();
    expect(row?.claim_status).toBe('stale');
    expect((row?.claimed_by_github_user_ids as number[]).map(Number)).toEqual([]); // claimant cleared
  });

  it('a claimant who STILL has permission → no change (stays claimed)', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    await seedContributor(30, 'carol');
    await claimAs('carol', 30, 'admin');
    // carol still admin (h.perm unchanged):
    const changes = await svc.recheckClaimantPermissions();
    expect(changes).toEqual([]);
    expect((await rawRow())?.claim_status).toBe('claimed');
  });

  it('multi-claimant: one loses, one keeps → pruned to the survivor, stays claimed', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    await seedContributor(30, 'carol');
    await seedContributor(40, 'dave');
    h.perm = { carol: 'admin', dave: 'maintain' };
    h.acting = { login: 'carol', id: 30 };
    await svc.claimBinding({ binding_id: 'github:555' });
    h.acting = { login: 'dave', id: 40 };
    await svc.claimBinding({ binding_id: 'github:555' });
    // dave loses permission; carol keeps admin.
    h.perm = { carol: 'admin', dave: 'none' };

    const changes = await svc.recheckClaimantPermissions();
    expect(changes).toEqual([{ binding_id: 'github:555', old_status: 'claimed', new_status: 'claimed' }]);
    const row = await rawRow();
    expect(row?.claim_status).toBe('claimed');
    expect((row?.claimed_by_github_user_ids as number[]).map(Number)).toEqual([30]); // dave pruned
  });

  it('FAIL-SAFE: a transient GitHub error during re-check NEVER demotes', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    await seedContributor(30, 'carol');
    await claimAs('carol', 30, 'admin');
    h.perm = { carol: 'THROW' }; // getRepoPermission throws (GitHub down)

    const changes = await svc.recheckClaimantPermissions();
    expect(changes).toEqual([]);
    expect((await rawRow())?.claim_status).toBe('claimed'); // kept — never demote on uncertainty
  });

  it('FAIL-SAFE: a claimant whose login cannot be resolved (no contributors row) is KEPT', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    // NO seedContributor → carol's id 30 cannot be resolved to a login.
    await claimAs('carol', 30, 'admin');
    h.perm = {}; // would be 'none' if checked — but login is unresolvable so it isn't
    const changes = await svc.recheckClaimantPermissions();
    expect(changes).toEqual([]);
    expect((await rawRow())?.claim_status).toBe('claimed'); // kept — can't verify, don't demote
  });

  it('cleanup branch: a claimed binding with an EMPTY claimant list flips to stale', async () => {
    await createUnclaimed({ login: 'alice', id: 10 });
    await db.sql`UPDATE harness_shared.shared_repo_binding_cache
                    SET claim_status='claimed', claimed_by_github_user_ids='{}'`;
    const changes = await svc.recheckClaimantPermissions();
    expect(changes).toEqual([{ binding_id: 'github:555', old_status: 'claimed', new_status: 'stale' }]);
    expect((await rawRow())?.claim_status).toBe('stale');
  });
});

// ── Scenario 7: renamed / deleted repo resolve honestly ──────────────────────
describe('resolveRepoIdentity — renamed / deleted repo (Brief AI scenario 7)', () => {
  it('a renamed repo refreshes the cached full_name (numeric id is the stable key)', async () => {
    await createUnclaimed({ login: 'alice', id: 10 }); // cached full_name acme/widgets
    h.repo = { id: 555, full_name: 'acme/widgets-renamed', private: false };
    const ident = await svc.resolveRepoIdentity('https://github.com/acme/widgets');
    expect(ident.github_full_name).toBe('acme/widgets-renamed');
    expect((await rawRow())?.github_full_name).toBe('acme/widgets-renamed');
  });

  it('a deleted repo (GitHub 404) → GITHUB_REPO_NOT_FOUND, no row written', async () => {
    h.repo = { httpStatus: 404 };
    await expect(svc.resolveRepoIdentity('https://github.com/acme/gone')).rejects.toMatchObject({
      error: { code: 'GITHUB_REPO_NOT_FOUND' },
    });
  });

  it('a rate-limited GitHub (403 + x-ratelimit-remaining:0) → GITHUB_API_RATE_LIMIT', async () => {
    h.repo = { httpStatus: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' } };
    await expect(svc.resolveRepoIdentity('https://github.com/acme/widgets')).rejects.toMatchObject({
      error: { code: 'GITHUB_API_RATE_LIMIT' },
    });
  });
});

// ── Scenario 6: federation honesty GUARD (documents the AI-5 finding) ─────────
describe('claim_status federation (Brief AI scenario 6) — AI-5 GUARD', () => {
  it('AI-5 FINDING (S1): shared_repo_binding_cache is NOT in the federated table set', async () => {
    const { PEER_LOG_TABLES } = await import('../../harness-state/table-registry');
    // The claim/authority state has NO substrate capture + NO projection, so it
    // never crosses to a member. This GUARD pins that reality: if someone later
    // federates it, this test must be updated (consciously), and the AI-5 honesty
    // gap (a member of a CLAIMED hive sees 'unclaimed') is closed.
    expect(PEER_LOG_TABLES).not.toContain('shared_repo_binding_cache');
  });
});
