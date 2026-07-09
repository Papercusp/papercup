/**
 * hive-revoke-contributor — the Hive-scope owner-revocation decision
 * (shared-hive-federation P-006). Hermetic: all PG/keychain/gh seams injected.
 */

import { describe, it, expect } from 'vitest';
import { revokeHiveContributor, type RevokeHiveContributorSeams } from './hive-revoke-contributor';

function seams(over: Partial<RevokeHiveContributorSeams> = {}): RevokeHiveContributorSeams {
  return {
    isOwningSwarm: async () => true,
    resolveOwnerGithubUserId: async () => 1,
    loadTargetPubkeys: async () => ['t-pk-1', 't-pk-2'],
    publishRevocation: async () => ({ live: false }),
    ...over,
  };
}

const input = { workspaceId: 'ws', potHomeSlug: 'alpha', githubUserId: 42 };

describe('revokeHiveContributor', () => {
  it('happy path: the owner revokes the target device pubkeys into their own row', async () => {
    let published: string[] | null = null;
    let publishedOwner: number | null = null;
    const r = await revokeHiveContributor(
      input,
      seams({
        publishRevocation: async (_ws, _slug, owner, pks) => {
          publishedOwner = owner;
          published = pks;
          return { live: true };
        },
      }),
    );
    expect(r).toEqual({ ok: true, revokedPubkeys: ['t-pk-1', 't-pk-2'], live: true });
    expect(publishedOwner).toBe(1);
    expect(published).toEqual(['t-pk-1', 't-pk-2']);
  });

  it('rejects a non-positive-integer target id (bad_target)', async () => {
    expect(await revokeHiveContributor({ ...input, githubUserId: 0 }, seams())).toMatchObject({ ok: false, code: 'bad_target' });
    expect(await revokeHiveContributor({ ...input, githubUserId: -1 }, seams())).toMatchObject({ ok: false, code: 'bad_target' });
  });

  it('not_owner when this Swarm does not hold the Hive key — and short-circuits BEFORE loading the target', async () => {
    let loaded = false;
    const r = await revokeHiveContributor(
      input,
      seams({
        isOwningSwarm: async () => false,
        loadTargetPubkeys: async () => {
          loaded = true;
          return ['x'];
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'not_owner' });
    expect(loaded).toBe(false); // no target lookup leaks to a non-owner
  });

  it('no_owner_identity when the local gh identity is unavailable', async () => {
    expect(await revokeHiveContributor(input, seams({ resolveOwnerGithubUserId: async () => null }))).toMatchObject({
      ok: false,
      code: 'no_owner_identity',
    });
  });

  it('no_target when the target has no bound devices', async () => {
    expect(await revokeHiveContributor(input, seams({ loadTargetPubkeys: async () => [] }))).toMatchObject({
      ok: false,
      code: 'no_target',
    });
  });

  it('no_owner_row when the owner has not joined the Hive (publish throws no-row)', async () => {
    const r = await revokeHiveContributor(
      input,
      seams({
        publishRevocation: async () => {
          throw new Error('owner has no hive_members row — join the Hive before revoking');
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'no_owner_row' });
  });

  it('revoke_failed on an unexpected publish error', async () => {
    expect(
      await revokeHiveContributor(input, seams({ publishRevocation: async () => { throw new Error('pg down'); } })),
    ).toMatchObject({ ok: false, code: 'revoke_failed', detail: 'pg down' });
  });
});
