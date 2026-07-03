/**
 * scope-serve-gate unit tests — the §5.3 roster serve-gate for scope repos
 * (P-108 / D-018 option b): member → grant; everything else → typed refusal,
 * fail-closed; grants are mint-bound and path-bound.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { scopeRepoPath, type ScopeId } from './scope-repo';
import {
  authorizeScopeRepoServe,
  isIssuedScopeServeGrant,
  type ScopeMemberPredicate,
} from './scope-serve-gate';

const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 9603, slug: 'p006-rig-fleet' };
const MEMBER_UID = 279242982;

const OLD_ROOT = process.env.PAPERCUSP_HIVE_GIT_ROOT;
afterEach(() => {
  if (OLD_ROOT === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
  else process.env.PAPERCUSP_HIVE_GIT_ROOT = OLD_ROOT;
});

function repoPathFor(scope: ScopeId): string {
  process.env.PAPERCUSP_HIVE_GIT_ROOT = '/tmp/hg-serve-gate-root';
  return scopeRepoPath('my-hive', scope);
}

const memberOf =
  (uids: number[]): ScopeMemberPredicate =>
  (_scope, uid) =>
    uids.includes(uid);

describe('authorizeScopeRepoServe', () => {
  it('grants a member, bound to the exact path + peer', async () => {
    const repoPath = repoPathFor(SCOPE);
    const d = await authorizeScopeRepoServe({
      repoPath,
      peerGithubUserId: MEMBER_UID,
      isScopeMember: memberOf([MEMBER_UID]),
    });
    if (!d.ok) throw new Error(`expected grant, got ${d.refusal.reason}`);
    expect(d.grant).toEqual({
      repoPath,
      scopeId: 'fleet:9603/p006-rig-fleet',
      peerGithubUserId: MEMBER_UID,
    });
    expect(isIssuedScopeServeGrant(d.grant)).toBe(true);
  });

  it('refuses a non-member (not-a-member)', async () => {
    const d = await authorizeScopeRepoServe({
      repoPath: repoPathFor(SCOPE),
      peerGithubUserId: 424242,
      isScopeMember: memberOf([MEMBER_UID]),
    });
    expect(d).toMatchObject({
      ok: false,
      refusal: { reason: 'not-a-member', scopeId: 'fleet:9603/p006-rig-fleet', peerGithubUserId: 424242 },
    });
  });

  it('refuses when the roster THROWS (fail-closed roster-error)', async () => {
    const d = await authorizeScopeRepoServe({
      repoPath: repoPathFor(SCOPE),
      peerGithubUserId: MEMBER_UID,
      isScopeMember: () => {
        throw new Error('pg down');
      },
    });
    expect(d).toMatchObject({ ok: false, refusal: { reason: 'roster-error', detail: 'pg down' } });
  });

  it('refuses a malformed scope path (never consults the roster)', async () => {
    process.env.PAPERCUSP_HIVE_GIT_ROOT = '/tmp/hg-serve-gate-root';
    let consulted = false;
    const d = await authorizeScopeRepoServe({
      repoPath: '/tmp/hg-serve-gate-root/my-hive/scopes/fleet-0/x.git',
      peerGithubUserId: MEMBER_UID,
      isScopeMember: () => {
        consulted = true;
        return true;
      },
    });
    expect(d).toMatchObject({ ok: false, refusal: { reason: 'malformed-scope-path', scopeId: null } });
    expect(consulted).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses invalid peer id %s', async (uid) => {
    const d = await authorizeScopeRepoServe({
      repoPath: repoPathFor(SCOPE),
      peerGithubUserId: uid,
      isScopeMember: () => true,
    });
    expect(d).toMatchObject({ ok: false, refusal: { reason: 'invalid-peer-id' } });
  });

  it('a truthy-but-not-true membership answer is a refusal (fail-closed)', async () => {
    const d = await authorizeScopeRepoServe({
      repoPath: repoPathFor(SCOPE),
      peerGithubUserId: MEMBER_UID,
      isScopeMember: () => 1 as unknown as boolean,
    });
    expect(d).toMatchObject({ ok: false, refusal: { reason: 'not-a-member' } });
  });

  it('a hand-built grant look-alike is NOT an issued grant', () => {
    const forged = {
      repoPath: repoPathFor(SCOPE),
      scopeId: 'fleet:9603/p006-rig-fleet',
      peerGithubUserId: MEMBER_UID,
    };
    expect(isIssuedScopeServeGrant(forged)).toBe(false);
    expect(isIssuedScopeServeGrant(null)).toBe(false);
    expect(isIssuedScopeServeGrant('grant')).toBe(false);
  });
});
