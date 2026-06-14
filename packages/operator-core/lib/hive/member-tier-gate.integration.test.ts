/**
 * member-tier-gate.integration.test.ts — the B11 / P-014 owner-action gate against
 * real Postgres (shared-hive-collaboration-2026-06-14, D-011). Each case is a
 * SECURITY assertion: the gate must derive tiers from the GitHub collaborator
 * graph (mocked here) keyed on a VERIFIED hive member, and DENY owner actions to
 * anyone below owner tier — never trusting federated/self-claimed state.
 *
 * Mocks: getOrgPg → throwaway DB; binding-service.getRepoPermission → controllable
 * (the GitHub leg); the local-identity is injected via the gate's resolveIdentity
 * arg; the flag via setFlagOverridesForTest.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { FLAGS } from '@papercusp/flags';
import type { LocalGithubIdentity } from '../identity/resolve-local-github-identity';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  repoPerm: vi.fn(),
}));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// Bare factory — member-tier-gate only needs getRepoPermission, and nothing else
// in this graph imports binding-service (avoids dragging in octokit).
vi.mock('../harness/binding-service', () => ({
  getRepoPermission: (...args: unknown[]) => h.repoPerm(...args),
}));

const gate = await import('./member-tier-gate');

let db: FreshPgDb;
const WS = 'default';
const HIVE = 'team-hive';
const REPO = 'acme/widgets';

const DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.hive_members (
    workspace_id text NOT NULL,
    hive_home_slug text NOT NULL,
    github_user_id bigint NOT NULL,
    github_username text NOT NULL,
    display_name text,
    avatar_url text,
    device_attestations jsonb,
    revoked_pubkeys text[],
    binding_status text NOT NULL DEFAULT 'verified',
    repo_permission text,
    permission_checked_at bigint,
    PRIMARY KEY (workspace_id, hive_home_slug, github_user_id)
  );
  CREATE TABLE IF NOT EXISTS harness_shared.shared_repo_binding_cache (
    workspace_id text NOT NULL,
    github_repository_id bigint,
    github_full_name text,
    harness_slug text,
    claim_status text
  );`;

/** The verified local owner identity the gate will resolve to (injected). */
const identity = (githubUserId: number): (() => Promise<LocalGithubIdentity>) =>
  async () => ({ kind: 'ok', token: 't', githubUserId, githubLogin: 'alice' });
const noIdentity = (): Promise<LocalGithubIdentity> => Promise.resolve({ kind: 'gh_auth_required' });

async function bindRepo() {
  await db.sql`INSERT INTO harness_shared.shared_repo_binding_cache
    (workspace_id, github_repository_id, github_full_name, harness_slug, claim_status)
    VALUES (${WS}, 42, ${REPO}, ${HIVE}, 'claimed')`;
}
async function seedMember(opts: { githubUserId: number; username: string; bindingStatus?: string }) {
  await db.sql`INSERT INTO harness_shared.hive_members
    (workspace_id, hive_home_slug, github_user_id, github_username, binding_status)
    VALUES (${WS}, ${HIVE}, ${opts.githubUserId}, ${opts.username}, ${opts.bindingStatus ?? 'verified'})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('hive-tier-gate');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 90_000);
afterAll(async () => {
  setFlagOverridesForTest(null);
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.hive_members, harness_shared.shared_repo_binding_cache`;
  h.repoPerm.mockReset();
  setFlagOverridesForTest({ [FLAGS.HIVE_ROLE_TIERS]: true }); // ON for every case except the flag-off test
});
afterEach(() => setFlagOverridesForTest(null));

describe('requireHiveTier — the owner-action gate (B11 / P-014)', () => {
  it('SOLO/unbound hive → owner (the local owner is never locked out of their own hive)', async () => {
    // No binding row → solo.
    const r = await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: noIdentity });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('solo-unbound');
    expect(h.repoPerm).not.toHaveBeenCalled(); // no GitHub call on a solo hive
  });

  it('SHARED + local owner is admin → owner action ALLOWED', async () => {
    await bindRepo();
    await seedMember({ githubUserId: 1, username: 'alice' });
    h.repoPerm.mockResolvedValue('admin');
    const r = await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: identity(1) });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('owner');
    expect(h.repoPerm).toHaveBeenCalledWith('acme', 'widgets', 'alice'); // derived from the repo + member username
  });

  it('SHARED + local owner is read → owner action DENIED (the DONE-WHEN)', async () => {
    await bindRepo();
    await seedMember({ githubUserId: 1, username: 'alice' });
    h.repoPerm.mockResolvedValue('read');
    const r = await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: identity(1) });
    expect(r.ok).toBe(false);
    expect(r.tier).toBe('read-only');
  });

  it('SHARED + write → collaborator: passes a collaborator gate, DENIED an owner gate', async () => {
    await bindRepo();
    await seedMember({ githubUserId: 1, username: 'alice' });
    h.repoPerm.mockResolvedValue('write');
    expect((await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'collaborator', resolveIdentity: identity(1) })).ok).toBe(true);
    expect((await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: identity(1) })).ok).toBe(false);
  });

  it('SHARED + member binding UNVERIFIED → DENIED, and GitHub is never consulted', async () => {
    await bindRepo();
    await seedMember({ githubUserId: 1, username: 'alice', bindingStatus: 'pending' });
    const r = await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: identity(1) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unverified');
    expect(h.repoPerm).not.toHaveBeenCalled();
  });

  it('SHARED + caller is NOT a hive member → DENIED', async () => {
    await bindRepo();
    await seedMember({ githubUserId: 1, username: 'alice' });
    const r = await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: identity(999) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-a-member');
  });

  it('SHARED + GitHub unresolvable (API down) → fail CLOSED', async () => {
    await bindRepo();
    await seedMember({ githubUserId: 1, username: 'alice' });
    h.repoPerm.mockRejectedValue(new Error('GITHUB_API_DOWN'));
    const r = await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: identity(1) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('github-unresolvable');
  });

  it('SHARED + no resolvable GitHub identity → fail CLOSED (gh-auth-required)', async () => {
    await bindRepo();
    const r = await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: noIdentity });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('gh-auth-required');
  });

  it('flag OFF → no-op (today\'s behavior); GitHub is never consulted', async () => {
    setFlagOverridesForTest({ [FLAGS.HIVE_ROLE_TIERS]: false });
    await bindRepo();
    await seedMember({ githubUserId: 1, username: 'alice' });
    h.repoPerm.mockResolvedValue('read'); // would DENY if the flag were on
    const r = await gate.requireHiveTier({ workspaceId: WS, hiveSlug: HIVE, minTier: 'owner', resolveIdentity: identity(1) });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('flag-off');
    expect(h.repoPerm).not.toHaveBeenCalled();
  });
});

describe('resolveHiveMemberTier — cache vs live', () => {
  it('owner-action (live) re-derives + writes the cache; a later non-live read uses it', async () => {
    await bindRepo();
    await seedMember({ githubUserId: 1, username: 'alice' });
    h.repoPerm.mockResolvedValue('maintain');

    const live = await gate.resolveHiveMemberTier({ workspaceId: WS, hiveSlug: HIVE, githubUserId: 1, live: true });
    expect(live).toMatchObject({ tier: 'owner', reason: 'github' });
    // Cache was written.
    const row = await db.sql<{ repo_permission: string | null }[]>`
      SELECT repo_permission FROM harness_shared.hive_members
       WHERE workspace_id = ${WS} AND hive_home_slug = ${HIVE} AND github_user_id = 1`;
    expect(row[0]?.repo_permission).toBe('maintain');

    // A non-live read uses the fresh cache — no second GitHub call.
    h.repoPerm.mockClear();
    const cached = await gate.resolveHiveMemberTier({ workspaceId: WS, hiveSlug: HIVE, githubUserId: 1, live: false });
    expect(cached).toMatchObject({ tier: 'owner', reason: 'cache' });
    expect(h.repoPerm).not.toHaveBeenCalled();
  });
});
